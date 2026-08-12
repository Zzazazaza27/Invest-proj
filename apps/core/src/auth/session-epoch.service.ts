import { Injectable } from '@nestjs/common';
import { Database, type Tx } from '../db/unit-of-work';

/**
 * Рубеж действительности сессий пользователя.
 *
 * Роли и признак второго фактора берутся из токена — иначе каждый запрос стоил
 * бы обращения к БД. Плата за это известна: изменение прав в базе не влияет на
 * уже выданный токен до его истечения. Снятая роль администратора продолжала
 * действовать час (SEC-08).
 *
 * Рубеж закрывает именно это: токен, выпущенный раньше отметки пользователя,
 * отклоняется. Отметка сдвигается там, где права или доверие к сессии
 * изменились — при выдаче и снятии роли, смене пароля, выходе из всех сессий.
 *
 * Кеш на несколько секунд — сознательный компромисс, названный числом: без него
 * каждый запрос читал бы БД, с бесконечным кешем отзыв снова стал бы
 * отложенным. Задержка ограничена `CACHE_TTL_MS` и объявлена здесь, а не
 * спрятана в «примерно сразу».
 */
@Injectable()
export class SessionEpochService {
  private readonly cache = new Map<string, { validFrom: number; readAt: number }>();

  constructor(private readonly db: Database) {}

  /** Действителен ли токен, выпущенный в момент `issuedAtSeconds`. */
  async isTokenValid(userId: string, issuedAtSeconds: number | null): Promise<boolean> {
    const validFrom = await this.validFrom(userId);
    if (validFrom === null) return true;
    // Токен без iat считается недействительным при сдвинутом рубеже: иначе
    // отзыв обходился бы токеном без отметки времени.
    if (issuedAtSeconds === null) return validFrom === 0;
    // Сравнение с точностью СЕКУНДЫ, а не миллисекунды. Причина не в удобстве:
    // `iat` записывается целыми секундами, а отметка рубежа — с долями. При
    // прямом сравнении токен, выпущенный в ту же секунду, что и создание
    // пользователя, оказывался «выпущенным раньше рубежа» и отклонялся — то
    // есть отклонялись ВСЕ сессии сразу после регистрации (поймано прогоном).
    //
    // Плата за округление — окно в одну секунду после сдвига рубежа, в которое
    // токен той же секунды считается действительным. На фоне кеша в пять
    // секунд это ничего не меняет.
    return issuedAtSeconds >= Math.floor(validFrom / 1000);
  }

  /** Сдвинуть рубеж: все ранее выданные токены пользователя перестают действовать. */
  async invalidate(tx: Tx, userId: string): Promise<void> {
    // Рубеж ставится на НАЧАЛО СЛЕДУЮЩЕЙ секунды, а не на «сейчас».
    //
    // Сравнение идёт с точностью секунды (у `iat` другой не бывает), поэтому
    // рубеж «сейчас» оставлял бы действительным токен, выпущенный в ту же
    // секунду, — и не на секунду, а НАВСЕГДА: отзыв просто не срабатывал бы
    // для сессии, созданной в тот же миг. Поймано прогоном отзыва прав.
    //
    // Плата: токен, выпущенный в ту же секунду, тоже недействителен, и человек
    // входит заново. Для операции «права изменились» это правильная сторона.
    await tx.query(
      `UPDATE identity.users
          SET sessions_valid_from = date_trunc('second', now()) + interval '1 second'
        WHERE id = $1`,
      [userId],
    );
    this.cache.delete(userId);
  }

  private async validFrom(userId: string): Promise<number | null> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) return cached.validFrom;

    const validFrom = await this.db.asServiceRole(
      'app_auth',
      { traceId: `epoch-${userId}` },
      async (tx) => {
        const { rows } = await tx.query<{ sessions_valid_from: Date | null }>(
          `SELECT sessions_valid_from FROM identity.users WHERE id = $1`,
          [userId],
        );
        return rows[0]?.sessions_valid_from ?? null;
      },
    );

    const value = validFrom === null ? null : validFrom.getTime();
    if (value !== null) this.cache.set(userId, { validFrom: value, readAt: Date.now() });
    return value;
  }
}

/**
 * Сколько отметка живёт в кеше. Пять секунд: заметно меньше любого разумного
 * времени реакции человека на инцидент и заметно больше длительности одного
 * запроса, поэтому нагрузки на БД не создаёт.
 */
const CACHE_TTL_MS = 5000;
