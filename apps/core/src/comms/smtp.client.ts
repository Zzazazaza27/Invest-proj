import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/**
 * Минимальный SMTP-клиент отправки.
 *
 * Почему свой, а не библиотека. Нужен ровно один сценарий: отдать одно
 * текстовое письмо одному получателю через smarthost с аутентификацией. Всё
 * остальное, что даёт универсальная библиотека (пулы соединений, вложения,
 * HTML-сборка, DKIM-подпись на клиенте, OAuth-механизмы), в этот сценарий не
 * входит и приносит с собой поверхность, которую пришлось бы аудировать
 * целиком. Здесь код помещается на один экран проверок и не зависит ни от
 * одного внешнего пакета — как и подпись SigV4 в зондах хранилища.
 *
 * Что этот клиент НЕ делает и не должен:
 *
 * - не отключает проверку сертификата — ни флагом, ни опцией, никогда;
 * - не отправляет учётные данные до того, как канал зашифрован;
 * - не поддерживает несколько получателей: рассылка — это другая задача с
 *   другими требованиями (отписка, дозирование, обработка отказов);
 * - не хранит соединение между письмами: письма редки, а живой сокет к
 *   почтовому релею — это ещё одно состояние, которое умеет протухать.
 */

/** Как защищён канал до релея. */
export type SmtpSecurity =
  /** Открытое соединение, затем обязательный STARTTLS. Порты 587 и 2525. */
  | 'starttls'
  /** TLS с первого байта. Порт 465. */
  | 'tls'
  /**
   * Без шифрования вообще.
   *
   * Существует ровно для локального почтового приёмника на петле (mailpit в
   * `infra/docker-compose.yml`), где сквозной прогон обязан пройти настоящий
   * SMTP-диалог, а не его имитацию. Запрещён к любому нелокальному адресу и
   * несовместим с аутентификацией — обе проверки ниже, в `assertUsable`.
   */
  | 'plain';

export interface SmtpTarget {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Пустая строка — «релей без аутентификации» (локальный приёмник). */
  user: string;
  password: string;
  /** Имя, которым клиент представляется в EHLO. */
  ehloName: string;
  /** Потолок на каждую фазу диалога, не на письмо целиком. */
  timeoutMs: number;
}

export interface SmtpEnvelope {
  /** Адрес конверта. Может отличаться от заголовка `From`. */
  from: string;
  /** Ровно один получатель. */
  to: string;
  /** Готовое письмо: заголовки, пустая строка, тело. */
  data: string;
}

/**
 * Отказ SMTP-диалога.
 *
 * Несёт код ответа и фазу, но НИКОГДА не тело письма и не пароль: текст этой
 * ошибки уходит в лог, а лог читает больше людей, чем почтовый ящик.
 */
export class SmtpError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

interface Reply {
  code: number;
  lines: string[];
}

const CRLF = '\r\n';

/**
 * Проверка конфигурации до попытки соединения.
 *
 * Вынесена отдельно, потому что вызывается дважды: при старте (чтобы
 * неверная настройка падала на запуске, а не на первом письме) и перед каждой
 * отправкой (чтобы горячая правка окружения не открыла дыру молча).
 */
export function assertUsable(target: SmtpTarget): void {
  if (!target.host) throw new SmtpError('не задан адрес релея', 'config');
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
    throw new SmtpError('порт релея вне диапазона', 'config');
  }
  if (target.security === 'plain') {
    // Открытый SMTP наружу — это письма и учётные данные в чужой сети. Здесь
    // проверяется именно ЛИТЕРАЛ адреса, а не результат DNS: имя, которое
    // сегодня резолвится в петлю, завтра резолвится куда угодно.
    if (!isLoopbackLiteral(target.host)) {
      throw new SmtpError(
        'соединение без шифрования допускается только к локальному приёмнику на петле',
        'config',
      );
    }
    if (target.user) {
      throw new SmtpError('учётные данные не отправляются по нешифрованному каналу', 'config');
    }
  }
  if (target.user && !target.password) {
    throw new SmtpError('для входа на релей задано имя без пароля', 'config');
  }
}

/**
 * SNI для рукопожатия.
 *
 * Имя сервера передаётся только когда это ИМЯ: RFC 6066 запрещает ставить в
 * SNI IP-адрес, и Node о таком предупреждает, а будущие версии просто
 * проигнорируют значение. Проверку сертификата это не ослабляет — при
 * подключении по адресу цепочка сверяется с адресом.
 */
function sniFor(host: string): { servername?: string } {
  const bare = host.replace(/^\[|\]$/g, '');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':');
  return isIp ? {} : { servername: host };
}

/** Литерал петли: `127.0.0.0/8`, `::1` и имя `localhost`. */
function isLoopbackLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return false;
  return octets[0] === 127;
}

/** Отдать одно письмо и закрыть соединение. */
export async function smtpDeliver(target: SmtpTarget, envelope: SmtpEnvelope): Promise<void> {
  assertUsable(target);
  assertAddress(envelope.from, 'from');
  assertAddress(envelope.to, 'to');

  const session = await openSession(target);
  try {
    await session.expect(220, 'greeting');
    let caps = await session.ehlo(target.ehloName);

    if (target.security === 'starttls') {
      if (!caps.has('STARTTLS')) {
        throw new SmtpError('релей не предлагает STARTTLS', 'starttls');
      }
      await session.startTls(target.host);
      // EHLO повторяется обязательно: возможности, объявленные до шифрования,
      // объявлены кем угодно — до TLS их мог подменить тот, кто сидит в канале.
      caps = await session.ehlo(target.ehloName);
    }

    if (target.user) {
      if (!session.encrypted) {
        throw new SmtpError('канал не зашифрован — вход на релей отменён', 'auth');
      }
      await session.authenticate(target.user, target.password, caps);
    }

    await session.command(`MAIL FROM:<${envelope.from}>`, 250, 'mail-from');
    await session.command(`RCPT TO:<${envelope.to}>`, 250, 'rcpt-to');
    await session.command('DATA', 354, 'data');
    await session.sendBody(envelope.data);
    await session.expect(250, 'body');
    await session.quit();
  } finally {
    session.close();
  }
}

/**
 * Адрес конверта не должен содержать ничего, что закрывает команду.
 *
 * Перевод строки внутри адреса — это дописанная SMTP-команда: `RCPT TO` на
 * чужой ящик, вторая `DATA`, что угодно. Адреса приходят из базы, но
 * проверяются здесь: транспорт не обязан верить вызывающему коду.
 */
function assertAddress(address: string, field: string): void {
  if (!address || /[\r\n\0<>]/.test(address) || address.length > 254) {
    throw new SmtpError(`недопустимый адрес в поле ${field}`, 'config');
  }
}

async function openSession(target: SmtpTarget): Promise<SmtpSession> {
  const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      raw.destroy();
      reject(new SmtpError('таймаут соединения с релеем', 'connect'));
    }, target.timeoutMs);

    const done = (error?: Error): void => {
      clearTimeout(timer);
      // Слушатель снимается сразу: оставленный на сокете, он при позднем сбое
      // рвал бы уже рабочее соединение мимо обработчиков сессии.
      raw.off('error', done);
      if (error) {
        raw.destroy();
        reject(new SmtpError(`соединение с релеем не установлено: ${error.message}`, 'connect'));
      } else {
        resolve(raw);
      }
    };

    const raw =
      target.security === 'tls'
        ? tlsConnect(
            {
              host: target.host,
              port: target.port,
              ...sniFor(target.host),
              minVersion: 'TLSv1.2',
            },
            () => done(),
          )
        : createConnection({ host: target.host, port: target.port }, () => done());

    raw.once('error', done);
  });

  return new SmtpSession(socket, target.timeoutMs, target.security === 'tls');
}

class SmtpSession {
  private socket: Socket | TLSSocket;
  private buffer = '';
  /** Строки уже начатого, но ещё не закрытого многострочного ответа. */
  private pending: string[] = [];
  private replies: Reply[] = [];
  private waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  private closed = false;

  constructor(
    socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
    private secure: boolean,
  ) {
    this.socket = socket;
    this.bind(socket);
  }

  get encrypted(): boolean {
    return this.secure;
  }

  private bind(socket: Socket | TLSSocket): void {
    socket.setTimeout(this.timeoutMs);
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('timeout', this.onTimeout);
    socket.on('close', this.onClose);
  }

  private unbind(socket: Socket | TLSSocket): void {
    socket.setTimeout(0);
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('timeout', this.onTimeout);
    socket.off('close', this.onClose);
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf8');
    // Многострочный ответ заканчивается строкой, где после кода пробел, а не
    // дефис: `250-STARTTLS` — продолжение, `250 OK` — конец.
    for (;;) {
      const end = this.buffer.indexOf(CRLF);
      if (end === -1) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.pending.push(line);
      if (/^\d{3} /.test(line)) {
        const lines = this.pending;
        this.pending = [];
        this.deliver({ code: Number(lines[lines.length - 1]!.slice(0, 3)), lines });
      }
    }
  };

  private readonly onError = (error: Error): void => {
    this.fail(new SmtpError(`сбой соединения: ${error.message}`, 'socket'));
  };

  private readonly onTimeout = (): void => {
    this.fail(new SmtpError('релей не ответил в отведённое время', 'socket'));
  };

  private readonly onClose = (): void => {
    this.fail(new SmtpError('релей закрыл соединение', 'socket'));
  };

  private deliver(reply: Reply): void {
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(reply);
      return;
    }
    this.replies.push(reply);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(error);
    }
  }

  private read(): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private write(line: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(line + CRLF);
  }

  async expect(code: number, stage: string): Promise<Reply> {
    const reply = await this.read();
    if (reply.code !== code) {
      throw new SmtpError(`релей отказал на этапе ${stage}: ${reply.lines[0]}`, stage, reply.code);
    }
    return reply;
  }

  async command(line: string, code: number, stage: string): Promise<Reply> {
    this.write(line);
    return this.expect(code, stage);
  }

  /** EHLO и разбор объявленных возможностей. */
  async ehlo(name: string): Promise<Set<string>> {
    const reply = await this.command(`EHLO ${name}`, 250, 'ehlo');
    const caps = new Set<string>();
    for (const line of reply.lines.slice(1)) {
      const value = line.slice(4).trim().toUpperCase();
      if (value) caps.add(value.split(' ')[0]!);
      // Механизмы входа объявляются одной строкой: `AUTH PLAIN LOGIN`.
      if (value.startsWith('AUTH ')) {
        for (const mech of value.slice(5).split(/\s+/)) caps.add(`AUTH=${mech}`);
      }
    }
    return caps;
  }

  async startTls(host: string): Promise<void> {
    this.write('STARTTLS');
    await this.expect(220, 'starttls');

    // Всё, что релей прислал ДО перехода на шифрование, должно быть прочитано
    // и обработано до этой точки. Непустой буфер здесь означает, что кто-то
    // дописал команды в открытый канал, рассчитывая, что они выполнятся уже
    // как доверенные, — это классическая инъекция в STARTTLS. Соединение
    // рвётся, письмо не уходит.
    if (this.buffer.length > 0 || this.pending.length > 0 || this.replies.length > 0) {
      throw new SmtpError('в открытом канале остались непрочитанные данные', 'starttls');
    }

    const plain = this.socket;
    this.unbind(plain);
    const secured = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        upgraded.destroy();
        reject(new SmtpError('таймаут TLS-рукопожатия', 'starttls'));
      }, this.timeoutMs);
      const upgraded = tlsConnect(
        {
          socket: plain,
          ...sniFor(host),
          minVersion: 'TLSv1.2',
        },
        () => {
          clearTimeout(timer);
          resolve(upgraded);
        },
      );
      upgraded.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(new SmtpError(`TLS-рукопожатие не состоялось: ${error.message}`, 'starttls'));
      });
    });

    this.socket = secured;
    this.secure = true;
    this.bind(secured);
  }

  /**
   * Вход на релей.
   *
   * PLAIN предпочтительнее LOGIN: одна посылка вместо трёх и никакой
   * зависимости от текста приглашения. Оба механизма передают пароль в base64,
   * то есть открытым текстом, — поэтому вызывается это только поверх TLS
   * (проверено вызывающим кодом и здесь ещё раз).
   */
  async authenticate(user: string, password: string, caps: Set<string>): Promise<void> {
    if (!this.secure) throw new SmtpError('вход без шифрования запрещён', 'auth');

    if (caps.has('AUTH=PLAIN')) {
      const token = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');
      this.write(`AUTH PLAIN ${token}`);
      await this.expectAuth();
      return;
    }
    if (caps.has('AUTH=LOGIN')) {
      this.write('AUTH LOGIN');
      await this.expect(334, 'auth');
      this.write(Buffer.from(user, 'utf8').toString('base64'));
      await this.expect(334, 'auth');
      this.write(Buffer.from(password, 'utf8').toString('base64'));
      await this.expectAuth();
      return;
    }
    throw new SmtpError('релей не предлагает поддерживаемого механизма входа', 'auth');
  }

  /**
   * Ответ на вход разбирается отдельно: текст отказа релея может содержать
   * присланное имя пользователя, а его незачем тащить в исключение и в лог.
   */
  private async expectAuth(): Promise<void> {
    const reply = await this.read();
    if (reply.code !== 235) {
      throw new SmtpError('релей отклонил учётные данные', 'auth', reply.code);
    }
  }

  /** Тело письма с нормализацией переводов строк и точечной вставкой. */
  async sendBody(data: string): Promise<void> {
    // Одиночный LF внутри DATA — это разное «конец письма» для разных релеев,
    // на чём и построена контрабанда SMTP (SMTP smuggling): цепочка из двух
    // релеев расходится в том, где закончилось одно письмо и началось
    // подделанное следующее. Нормализация к CRLF снимает расхождение целиком.
    const normalized = data.replace(/\r\n|\r|\n/g, CRLF);
    // Строка, начинающаяся с точки, закрыла бы DATA досрочно.
    const stuffed = normalized.replace(/^\./gm, '..');
    this.write(stuffed.endsWith(CRLF) ? stuffed + '.' : stuffed + CRLF + '.');
  }

  async quit(): Promise<void> {
    this.write('QUIT');
    // Ответ на QUIT не обязателен для успеха: письмо уже принято ответом 250
    // на DATA. Ждать его до таймаута — значит задержать запрос ради формальности.
    await Promise.race([
      this.read().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unbind(this.socket);
    this.socket.destroy();
  }
}
