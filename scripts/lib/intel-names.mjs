/**
 * Market Intelligence: видно ли сущность в тексте (цитате или странице).
 * Общее для загрузчика находок и проверки страниц.
 */
const TRANSLIT = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};
const translit = (s) => [...s].map((c) => TRANSLIT[c] ?? c).join('');
const GENERIC = /^(венчурн|инвестиц|фонд|клуб|капитал|capital|ventures?|partners|group|holding)/;

/**
 * Видно ли сущность в цитате (ТЗ-перестройка §8: сущность на странице
 * действительно есть). Человек — по основе фамилии (первые 5 букв: переживает
 * склонение «Кольхаузер → Кольхаузера»), организация — по первому
 * значимому слову названия. Сверяется и кириллица, и латиница: сайты пишут
 * «Ryabenky» там, где у нас «Рябенький», — поэтому по согласным первых букв.
 */
export function namedIn(name, type, evidence) {
  if (!name || !evidence) return false;
  const hay = evidence.toLowerCase().replace(/ё/g, 'е');
  const words = name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/["«»“”„'`().,]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return hay.includes(name.toLowerCase());
  const key =
    type === 'person' ? words[words.length - 1] : (words.find((w) => !GENERIC.test(w)) ?? words[0]);
  const stem = key.slice(0, Math.min(5, key.length));
  if (hay.includes(stem)) return true;
  // Латиница на странице при кириллице у нас (и наоборот): сравнение по
  // согласному скелету начала слова, гласные в транслитерации разнятся.
  const skeleton = (s) =>
    translit(s)
      .replace(/[aeiouy]/g, '')
      .slice(0, 3);
  const want = skeleton(key);
  if (want.length < 3) return false;
  return hay
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length >= 3)
    .some((w) => skeleton(w) === want);
}
