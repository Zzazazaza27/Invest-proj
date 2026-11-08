import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { smtpCheck, smtpDeliver, type SmtpTarget } from '../src/comms/smtp.client';
import { decide, MAX_UNKNOWN } from '../src/comms/mail-queue.service';

/**
 * Исходы отправки письма (4.11, пакет «Почта»): настоящий SMTP-диалог с поддельным релеем
 * на петле. «Принято релеем» — только 250 после DATA; отказ до текста — «точно не ушло»;
 * обрыв после текста — «неизвестно».
 */
type Mode =
  'accept' | 'reject-rcpt' | 'temp-mail' | 'drop-after-data' | 'reject-body' | 'quit-fails';

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = null;
});

async function relay(mode: Mode): Promise<{ target: SmtpTarget; seen: string[] }> {
  const seen: string[] = [];
  server = createServer((socket: Socket) => {
    let inData = false;
    let buf = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            seen.push('DATA-END');
            if (mode === 'drop-after-data') socket.destroy();
            else if (mode === 'reject-body') socket.write('554 content rejected\r\n');
            else socket.write('250 queued\r\n');
          }
          continue;
        }
        const cmd = line.split(' ')[0]!.toUpperCase();
        seen.push(cmd);
        if (cmd === 'EHLO') socket.write('250-fake\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL')
          socket.write(mode === 'temp-mail' ? '421 try later\r\n' : '250 ok\r\n');
        else if (cmd === 'RCPT')
          socket.write(mode === 'reject-rcpt' ? '550 no such user\r\n' : '250 ok\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (cmd === 'QUIT') {
          if (mode === 'quit-fails') socket.destroy();
          else socket.end('221 bye\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
  const port = (server!.address() as { port: number }).port;
  return {
    seen,
    target: {
      host: '127.0.0.1',
      port,
      security: 'plain',
      user: '',
      password: '',
      ehloName: 'test.local',
      timeoutMs: 2000,
    },
  };
}

const envelope = {
  from: 'no-reply@fifth.local',
  to: 'inbox@fifth.local',
  data: 'Subject: t\r\n\r\nhi\r\n',
};

describe('Исход SMTP', () => {
  it('250 после DATA — принято релеем; сбой QUIT исхода не меняет', async () => {
    for (const mode of ['accept', 'quit-fails'] as const) {
      const { target } = await relay(mode);
      expect(await smtpDeliver(target, envelope)).toEqual({ outcome: 'accepted' });
      await new Promise<void>((done) => server!.close(() => done()));
      server = null;
    }
  });

  it('обрыв после текста письма — неизвестно', async () => {
    const { target, seen } = await relay('drop-after-data');
    expect(await smtpDeliver(target, envelope)).toMatchObject({ outcome: 'unknown' });
    expect(seen).toContain('DATA-END');
  });

  it('отказ получателя 5xx — не ушло по вине письма', async () => {
    const { target } = await relay('reject-rcpt');
    expect(await smtpDeliver(target, envelope)).toMatchObject({
      outcome: 'not_sent',
      scope: 'message',
      stage: 'rcpt-to',
      code: 550,
    });
  });

  it('явный отказ на текст 5xx — не ушло по вине письма, а не «неизвестно»', async () => {
    const { target } = await relay('reject-body');
    expect(await smtpDeliver(target, envelope)).toMatchObject({
      outcome: 'not_sent',
      scope: 'message',
      code: 554,
    });
  });

  it('временный отказ 4xx и недоступный релей — не ушло по вине канала', async () => {
    const { target } = await relay('temp-mail');
    expect(await smtpDeliver(target, envelope)).toMatchObject({
      outcome: 'not_sent',
      scope: 'transport',
    });
    const closed = { ...target, port: 1 };
    expect(await smtpDeliver(closed, envelope)).toMatchObject({
      outcome: 'not_sent',
      scope: 'transport',
      stage: 'connect',
    });
  });

  it('проверка транспорта входит и выходит, письма не начинает', async () => {
    const { target, seen } = await relay('accept');
    await smtpCheck(target);
    await new Promise((done) => setTimeout(done, 50));
    expect(seen).toContain('EHLO');
    expect(seen).not.toContain('MAIL');
    expect(seen).not.toContain('DATA');
  });
});

describe('Решение очереди служебных писем', () => {
  const row = { attempts: 0, unknownCount: 0 };
  const transport = {
    outcome: 'not_sent',
    scope: 'transport',
    stage: 'connect',
    code: null,
  } as const;
  const message = { outcome: 'not_sent', scope: 'message', stage: 'rcpt-to', code: 550 } as const;
  const unknown = { outcome: 'unknown', stage: 'body' } as const;

  it('отказ канала не расходует попыток и ставит отправщик на паузу', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(decide({ attempts: 4, unknownCount: 0 }, transport, 5)).toEqual({
        state: 'pending',
        countAttempt: false,
        countUnknown: false,
        pauseSender: true,
      });
    }
  });

  it('отказ по вине письма расходует попытку; на пределе — failed', () => {
    expect(decide(row, message, 5)).toMatchObject({ state: 'pending', countAttempt: true });
    expect(decide({ attempts: 4, unknownCount: 0 }, message, 5)).toEqual({ state: 'failed' });
  });

  it('неизвестный исход — один повтор, второй — окончательно «неизвестно»', () => {
    expect(MAX_UNKNOWN).toBe(1);
    expect(decide(row, unknown, 5)).toMatchObject({ state: 'pending', countUnknown: true });
    expect(decide({ attempts: 0, unknownCount: 1 }, unknown, 5)).toEqual({ state: 'unknown' });
  });

  it('принято релеем — accepted', () => {
    expect(decide({ attempts: 2, unknownCount: 1 }, { outcome: 'accepted' }, 5)).toEqual({
      state: 'accepted',
    });
  });
});
