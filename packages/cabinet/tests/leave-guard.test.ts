import { beforeEach, describe, expect, it } from 'vitest';
import {
  allowNextLeave,
  resetLeaveGuard,
  setLeaveSignals,
  shouldBlockInApp,
  shouldWarnOnUnload,
} from '../src/leave-guard';
import { guardedMemory, setGuardOwner } from '../src/guarded-send';

/** Уход со страницы (2.2/2.3), замечания Тэнка к 65456fa. */
beforeEach(() => {
  resetLeaveGuard();
  guardedMemory.clear();
  setGuardOwner(null);
});

describe('Разовый пропуск — только для завершённой формы', () => {
  it('черновик обращения + успешное создание проекта → переход держится', () => {
    setLeaveSignals('support.form', { dirty: true });
    setLeaveSignals('lab.project.create.form', { dirty: true });
    allowNextLeave('lab.project.create.form');
    expect(shouldBlockInApp()).toBe(true);
  });

  it('без чужого черновика проект открывается сразу', () => {
    setLeaveSignals('lab.project.create.form', { dirty: true });
    allowNextLeave('lab.project.create.form');
    expect(shouldBlockInApp()).toBe(false);
  });

  it('пропуск разовый: следующий переход снова учитывает форму', () => {
    setLeaveSignals('lab.project.create.form', { dirty: true });
    allowNextLeave('lab.project.create.form');
    shouldBlockInApp();
    expect(shouldBlockInApp()).toBe(true);
  });
});

describe('Незавершённая защищённая отправка — независимо от формы', () => {
  const pending = (owner: string) => ({ owner, key: 'k'.repeat(20), payload: { x: 1 }, at: 0 });

  it('неизвестный исход → форма размонтирована (другая страница) → перезагрузка предупреждает', () => {
    setGuardOwner('A');
    guardedMemory.set('A|lab.project.create', pending('A'));
    // Формы на странице нет — признаков форм нет.
    expect(shouldWarnOnUnload()).toBe(true);
    // Переход внутри кабинета не держится: ключ и снимок в памяти страницы.
    expect(shouldBlockInApp()).toBe(false);
  });

  it('завершение операции снимает предупреждение', () => {
    setGuardOwner('A');
    guardedMemory.set('A|lab.project.create', pending('A'));
    guardedMemory.delete('A|lab.project.create');
    expect(shouldWarnOnUnload()).toBe(false);
  });

  it('чужая отправка (другой владелец во вкладке) не учитывается', () => {
    guardedMemory.set('A|lab.project.create', pending('A'));
    setGuardOwner('B');
    expect(shouldWarnOnUnload()).toBe(false);
  });
});
