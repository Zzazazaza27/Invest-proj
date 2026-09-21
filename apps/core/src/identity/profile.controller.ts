import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AvatarSizeSchema,
  ChangePasswordResultSchema,
  ChangePasswordSchema,
  MediaUploadTicketSchema,
  MyProfileSchema,
  RequestAvatarUploadSchema,
  UpdateMyProfileSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ProfileService } from './profile.service';

/**
 * «Мой профиль» — один и тот же для всех кабинетов.
 *
 * Роли здесь не объявляются намеренно: профиль есть у каждого, кто вошёл, и
 * ограничивать его ролью значило бы оставить кого-то без собственного
 * аккаунта. Аутентификация при этом обязательна — маршрут не помечен
 * `@Public()`, а guard закрыт по умолчанию.
 *
 * Все действия работают только НАД СОБОЙ: идентификатор берётся из сессии, а
 * не из адреса. Поэтому здесь нечего проверять на владение — чужой профиль
 * этим путём не адресуется в принципе.
 */
@Controller('me')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('profile')
  async me(@Ctx() ctx: RequestContext) {
    return MyProfileSchema.parse(await this.profile.me(ctx));
  }

  @Patch('profile')
  async update(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(UpdateMyProfileSchema, rawBody);
    return MyProfileSchema.parse(await this.profile.updateName(ctx, input.displayName));
  }

  /**
   * Смена пароля.
   *
   * Ответ говорит прямо: сессии прекращены. Клиент обязан увести человека на
   * вход, а не делать вид, что ничего не случилось, — иначе следующий запрос
   * вернёт 401 без объяснения.
   */
  @HttpCode(200)
  @Post('password')
  async changePassword(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(ChangePasswordSchema, rawBody);
    await this.profile.changePassword(ctx, input);
    return ChangePasswordResultSchema.parse({ changed: true, sessionsClosed: true });
  }

  @Post('avatar/upload')
  async requestAvatarUpload(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(RequestAvatarUploadSchema, rawBody);
    return MediaUploadTicketSchema.parse(await this.profile.requestAvatarUpload(ctx, input));
  }

  @HttpCode(200)
  @Post('avatar/finalize')
  async finalizeAvatar(@Ctx() ctx: RequestContext) {
    return MyProfileSchema.parse(await this.profile.finalizeAvatar(ctx));
  }

  @Delete('avatar')
  async removeAvatar(@Ctx() ctx: RequestContext) {
    return MyProfileSchema.parse(await this.profile.removeAvatar(ctx));
  }
}

/**
 * Байты аватара — отдельный контроллер, потому что адрес другой: картинка
 * принадлежит человеку, а не «мне», и её показывают там, где показывают его
 * (список администратора, шапка, карточка).
 */
@Controller('users')
export class UserAvatarController {
  constructor(private readonly profile: ProfileService) {}

  @Get(':id/avatar/:size')
  async avatar(
    @Param('id') rawId: string,
    @Param('size') rawSize: string,
    @Ctx() ctx: RequestContext,
    @Res() reply: FastifyReply,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const size = parseOrThrow(AvatarSizeSchema, rawSize);
    const file = await this.profile.avatarBytes(ctx, id, size);
    await reply
      .header('content-type', file.contentType)
      .header('content-length', String(file.body.byteLength))
      // То же послабление и по той же причине, что у изображений проекта:
      // картинка существует, чтобы её показывали наши страницы. Минимальное —
      // `same-site`, чужой сайт встроить её всё равно не может.
      .header('cross-origin-resource-policy', 'same-site')
      .send(file.body);
  }
}
