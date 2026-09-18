/**
 * СГЕНЕРИРОВАНО scripts/build-application-form-v1.mjs из
 * docs/product/каталог-вопросов-заявки.md (версия 2). Не править руками:
 * до первой публикации формулировки правятся в каталоге и файл
 * перегенерируется, после — действующая конфигурация живёт в БД и правится
 * в админке, а этот документ остаётся запасным RU-текстом и источником
 * стартовой версии для сида (план 0.2 §0в.5).
 */
import type { ApplicationFormConfig } from './application-form';

export const APPLICATION_FORM_V1: ApplicationFormConfig = {
  locales: ['ru-RU'],
  defaultLocale: 'ru-RU',
  sections: [
    {
      key: 'project',
      order: 10,
      texts: {
        'ru-RU': {
          title: 'Проект',
          intro_md:
            'Здесь то, что уже известно о проекте. Проверьте, что название и описание актуальны: они попадут в карточку. Стадию выбирайте честно — от неё зависит, какие вопросы вы увидите дальше, и инвестор будет сверять её с результатами.',
        },
      },
    },
    {
      key: 'problem',
      order: 20,
      texts: {
        'ru-RU': {
          title: 'Проблема и клиент',
          intro_md:
            'Не описывайте продукт. Опишите проблему клиента, которая существует независимо от вашего решения, и человека, у которого она есть. Отсутствие вашего продукта — не проблема.',
        },
      },
    },
    {
      key: 'solution',
      order: 30,
      texts: {
        'ru-RU': {
          title: 'Решение и продукт',
          intro_md:
            'Что вы предлагаете и что из этого уже существует. Разделяйте: что работает сегодня, что в разработке, что пока замысел. Теги «ИИ», «SaaS», «блокчейн» — классификация, а не преимущество.',
        },
      },
    },
    {
      key: 'traction',
      order: 40,
      texts: {
        'ru-RU': {
          title: 'Результаты и динамика',
          intro_md:
            'Только факты: цифры, даты, названия. Здесь инвестор проверяет, что из сказанного выше подтверждено. Если результатов пока нет — напишите, какие первые подтверждения получили; это честнее, чем округлять.',
        },
      },
    },
    {
      key: 'market',
      order: 50,
      texts: {
        'ru-RU': {
          title: 'Рынок',
          intro_md:
            'Инвестору важнее, как вы считали, чем итоговая цифра. Оценка снизу вверх (число клиентов × средний чек) убедительнее ссылки на отчёт про «миллиарды».',
        },
      },
    },
    {
      key: 'competition',
      order: 60,
      texts: {
        'ru-RU': {
          title: 'Конкуренты и альтернативы',
          intro_md:
            '«Конкурентов нет» — слабый ответ: либо рынка нет, либо вы их не искали. Клиент всегда как-то решает проблему — это и есть ваш конкурент.',
        },
      },
    },
    {
      key: 'business_model',
      order: 70,
      texts: {
        'ru-RU': {
          title: 'Бизнес-модель и выход на рынок',
          intro_md:
            'Кто платит, за что и как вы до него дотягиваетесь. На ранней стадии это гипотеза — так и скажите, но сформулируйте её конкретно.',
        },
      },
    },
    {
      key: 'team',
      order: 80,
      texts: {
        'ru-RU': {
          title: 'Основатели и команда',
          intro_md:
            'Инвестор ищет не размер команды, а машину, которая превращает планы в результат. Один основатель с подтверждённой способностью доводить дело до конца сильнее большой формальной команды. Прошлый неуспешный проект — ценный опыт, если показывает реальную работу и уроки.',
        },
      },
    },
    {
      key: 'execution',
      order: 90,
      texts: {
        'ru-RU': {
          title: 'Организация исполнения',
          intro_md:
            'Название инструмента ничего не доказывает. Инвестор смотрит, есть ли рабочий цикл: план → приоритеты → работа → результат → пересмотр, и что вышло за последние месяцы.',
        },
      },
    },
    {
      key: 'economics',
      order: 100,
      texts: {
        'ru-RU': {
          title: 'Экономика и финансы',
          intro_md:
            'Показатели зависят от стадии и типа бизнеса: мы не спросим у идеи юнит-экономику, а у растущей компании не примем «ещё не считали». Если показатель есть, но грубый — укажите, как считали.',
        },
      },
    },
    {
      key: 'funding',
      order: 110,
      scope: 'round',
      texts: {
        'ru-RU': {
          title: 'Инвестиционный запрос',
          intro_md:
            'Не только сумма. Инвестор хочет увидеть цепочку: текущее состояние → сумма → на что пойдут → на сколько хватит → какие результаты → новое состояние проекта.',
        },
      },
    },
    {
      key: 'risks',
      order: 120,
      texts: {
        'ru-RU': {
          title: 'Риски и предположения',
          intro_md:
            'Здесь инвестор смотрит, умеете ли вы отличать факт от гипотезы. Проект без рисков — признак, что их не искали.',
        },
      },
    },
    {
      key: 'legal',
      order: 130,
      texts: {
        'ru-RU': {
          title: 'Юридическая готовность',
          intro_md:
            'Короткий блок. На ранней стадии достаточно понимать, есть ли юрлицо и кому принадлежит продукт; детали понадобятся при углублённой проверке.',
        },
      },
    },
    {
      key: 'materials',
      order: 140,
      texts: {
        'ru-RU': {
          title: 'Материалы и подтверждения',
          intro_md:
            'Подтверждения вы уже прикладывали к ответам. Здесь — общие материалы. Наличие файла не значит, что он прочитан и проверен: платформа видит тип материала, инвестор — содержимое.',
        },
      },
    },
  ],
  questions: [
    {
      key: 'stage',
      section: 'project',
      order: 10,
      type: 'select',
      options: [
        {
          code: 'idea',
          texts: {
            'ru-RU': {
              label: 'Идея',
            },
          },
        },
        {
          code: 'mvp',
          texts: {
            'ru-RU': {
              label: 'MVP',
            },
          },
        },
        {
          code: 'early_revenue',
          texts: {
            'ru-RU': {
              label: 'Первые продажи',
            },
          },
        },
        {
          code: 'growth',
          texts: {
            'ru-RU': {
              label: 'Рост',
            },
          },
        },
      ],
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'public',
      coreField: 'stage',
      texts: {
        'ru-RU': {
          label: 'На какой стадии проект?',
          help_md:
            'Стадия определяется тем, что уже есть, а не тем, что планируется. Если сомневаетесь между двумя — выбирайте более раннюю: инвестор охотнее простит скромность, чем несоответствие.\n\nКак понимать стадии:\n\n- **Идея** — идея: продукта ещё нет, есть понимание проблемы и первые разговоры с клиентами\n- **MVP** — есть работающая версия, ею пользуются, денег ещё нет или они случайны\n- **Первые продажи** — есть регулярно платящие клиенты, выручка ещё не главный источник роста\n- **Рост** — выручка растёт, есть повторяемые каналы привлечения, экономика считается',
        },
      },
    },
    {
      key: 'business_type',
      section: 'project',
      order: 20,
      type: 'select',
      options: [
        {
          code: 'saas',
          texts: {
            'ru-RU': {
              label: 'Подписка на программный продукт (SaaS)',
            },
          },
        },
        {
          code: 'marketplace',
          texts: {
            'ru-RU': {
              label: 'Маркетплейс или платформа',
            },
          },
        },
        {
          code: 'consumer',
          texts: {
            'ru-RU': {
              label: 'Потребительский продукт (B2C)',
            },
          },
        },
        {
          code: 'enterprise',
          texts: {
            'ru-RU': {
              label: 'Продажи компаниям (enterprise)',
            },
          },
        },
        {
          code: 'hardware_deeptech',
          texts: {
            'ru-RU': {
              label: 'Железо и deeptech',
            },
          },
        },
        {
          code: 'regulated_biotech',
          texts: {
            'ru-RU': {
              label: 'Регулируемая отрасль, биотех, медицина',
            },
          },
        },
        {
          code: 'other',
          texts: {
            'ru-RU': {
              label: 'Другое',
            },
          },
        },
      ],
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      coreField: 'business_type',
      texts: {
        'ru-RU': {
          label: 'Какой у вас тип бизнеса?',
          help_md:
            'От выбора зависит, какие показатели мы спросим в разделах «Результаты» и «Экономика». Если модель смешанная — выбирайте ту, откуда ожидаете основную выручку.',
        },
      },
    },
    {
      key: 'stage_evidence',
      section: 'project',
      order: 30,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'platform',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Почему вы относите проект к этой стадии?',
          help_md:
            'Два-три факта, которые подтверждают стадию: что работает, кто платит, какие цифры. Это не публикуется — помогает платформе понять, что стадия выбрана осознанно.',
          example_good_md:
            'MVP: приложение в TestFlight с марта, 140 установок, 35 человек пользуются каждую неделю, платежей нет',
          example_weak_md: 'Мы на стадии MVP, потому что у нас есть MVP',
        },
      },
    },
    {
      key: 'founded_year',
      section: 'project',
      order: 40,
      type: 'number',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      constraints: {
        min: 1990,
        max: 2100,
      },
      texts: {
        'ru-RU': {
          label: 'В каком году началась работа над проектом?',
          help_md:
            'Год первых действий по проекту, а не регистрации компании. От 1990 до текущего года.',
        },
      },
    },
    {
      key: 'website_url',
      section: 'project',
      order: 50,
      type: 'url',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      texts: {
        'ru-RU': {
          label: 'Сайт или страница продукта',
          help_md:
            'Если сайта нет — оставьте пустым; ссылку на демо попросим в разделе «Решение и продукт».',
        },
      },
    },
    {
      key: 'problem_statement',
      section: 'problem',
      order: 10,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'public',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Какую проблему вы решаете?',
          help_md:
            'Одна конкретная проблема, у конкретного человека или компании, с последствием — что теряют, если её не решить. Без упоминания вашего продукта.',
          example_good_md:
            'Владельцы небольших автосервисов теряют 15–20% записей, потому что ведут запись по телефону и в тетради; клиент, не дозвонившись, уходит к конкуренту',
          example_weak_md: 'На рынке нет удобного приложения для автосервисов',
        },
      },
    },
    {
      key: 'problem_severity',
      section: 'problem',
      order: 20,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Насколько проблема существенна для клиента?',
          help_md:
            'Как часто возникает, во что обходится (деньги, время, риск), готов ли клиент за решение платить или менять привычки. Оцените честно: «неприятно, но терпимо» — тоже ответ.',
          example_good_md:
            'Сервис на 4 поста теряет 8–12 записей в неделю, это 60–90 тыс. ₽ выручки в месяц; двое из десяти опрошенных уже платят за онлайн-запись 1,5–3 тыс. ₽ в месяц',
          example_weak_md: 'Проблема очень важная, все с ней сталкиваются',
        },
      },
    },
    {
      key: 'current_alternatives',
      section: 'problem',
      order: 30,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Как клиент решает эту проблему сейчас?',
          help_md:
            'Что делает клиент без вас: другой продукт, ручной способ, ничего не делает. Это же ответ на вопрос о косвенных конкурентах — там мы его не повторим.',
          example_good_md:
            'Тетрадь и телефон у 70% опрошенных, у 20% — запись в мессенджере, у 10% — YClients за 2 900 ₽ в месяц, от которого жалуются на сложность',
          example_weak_md: 'Никак не решает, аналогов нет',
        },
      },
    },
    {
      key: 'problem_evidence',
      section: 'problem',
      order: 40,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Откуда вы знаете, что проблема существует?',
          help_md:
            'Интервью (сколько, с кем, когда), собственный опыт, наблюдения, исследования, данные. Приложите заметки интервью, опрос или ссылку на исследование, если есть.',
          example_good_md:
            '22 интервью с владельцами сервисов в Казани и Самаре в мае–июне 2026, сводка приложена; сам 6 лет управлял сервисом',
          example_weak_md: 'Это очевидно, мы много общались с людьми',
        },
      },
    },
    {
      key: 'customer_user',
      section: 'problem',
      order: 50,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'public',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Кто пользуется продуктом?',
          help_md:
            'Конкретный человек или роль: кто он, в какой ситуации, что для него важно. Если продукт для компаний — кто внутри компании им пользуется.',
          example_good_md:
            'Мастер-приёмщик в сервисе на 2–6 постов, 25–45 лет, работает со смартфона между машинами, ценит скорость записи',
          example_weak_md: 'Все автовладельцы и автосервисы',
        },
      },
    },
    {
      key: 'customer_buyer',
      section: 'problem',
      order: 60,
      type: 'text',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 200,
      },
      texts: {
        'ru-RU': {
          label: 'Кто принимает решение о покупке и платит?',
          help_md:
            'Если это тот же человек, что пользуется, — так и напишите. Для компаний — должность и кто ещё влияет на решение.',
          example_good_md:
            'Владелец сервиса; при сети из 3+ точек — управляющий, с согласованием у владельца',
          example_weak_md: 'Клиенты',
        },
      },
    },
    {
      key: 'customer_model',
      section: 'problem',
      order: 70,
      type: 'select',
      options: [
        {
          code: 'b2b',
          texts: {
            'ru-RU': {
              label: 'Компаниям',
            },
          },
        },
        {
          code: 'b2c',
          texts: {
            'ru-RU': {
              label: 'Людям',
            },
          },
        },
        {
          code: 'b2g',
          texts: {
            'ru-RU': {
              label: 'Государству',
            },
          },
        },
        {
          code: 'b2b2c',
          texts: {
            'ru-RU': {
              label: 'Компаниям, которые обслуживают людей',
            },
          },
        },
        {
          code: 'mixed',
          texts: {
            'ru-RU': {
              label: 'Смешанная модель',
            },
          },
        },
      ],
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      texts: {
        'ru-RU': {
          label: 'Кому вы продаёте?',
          help_md: 'По основному источнику выручки.',
        },
      },
    },
    {
      key: 'customer_segment_priority',
      section: 'problem',
      order: 80,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Какой сегмент вы берёте первым и почему?',
          help_md:
            'Один узкий сегмент, с которого начинаете, и причина: где боль сильнее, где проще дотянуться, где уже есть клиенты. Остальные сегменты — потом.',
          example_good_md:
            'Независимые сервисы на 2–6 постов в городах-миллионниках Поволжья: там у нас 22 интервью и 4 пилота, и туда легко доехать',
          example_weak_md: 'Малый, средний и крупный бизнес по всей России и СНГ',
        },
      },
    },
    {
      key: 'target_markets',
      section: 'problem',
      order: 90,
      type: 'text',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      constraints: {
        maxLength: 200,
      },
      texts: {
        'ru-RU': {
          label: 'Страны или регионы, где вы продаёте или планируете продавать',
          help_md: 'Сначала текущие, затем ближайшие планы. Через запятую.',
          example_good_md: 'Россия (Татарстан, Самарская область); в 2027 — Казахстан',
          example_weak_md: 'Весь мир',
        },
      },
    },
    {
      key: 'purchase_decision',
      section: 'problem',
      order: 100,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Как клиент принимает решение о покупке?',
          help_md:
            'Кто участвует, что сравнивает, что должно случиться, чтобы он купил, сколько это занимает. Для компаний — есть ли тендер, пилот, безопасность, юристы.',
          example_good_md:
            'Владелец смотрит демо 20 минут, пробует 14 дней бесплатно, решает сам; средний срок от первого контакта до оплаты — 3 недели',
          example_weak_md: 'Клиенту нравится, и он покупает',
        },
      },
    },
    {
      key: 'solution_summary',
      section: 'solution',
      order: 10,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'public',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Как вы решаете проблему?',
          help_md:
            'В трёх-пяти предложениях: что делает продукт, для кого, в каком виде (приложение, сервис, устройство, услуга). Три-пять ключевых возможностей — списком.',
          example_good_md:
            'Онлайн-запись для автосервисов: клиент записывается сам по ссылке, мастер видит загрузку постов в приложении, система напоминает клиенту за день. Ключевое: запись без звонка, календарь постов, напоминания, история машины',
          example_weak_md: 'Инновационная платформа на базе ИИ для цифровизации автосервисов',
        },
      },
    },
    {
      key: 'value_over_alternatives',
      section: 'solution',
      order: 20,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Что клиент получает и чем это лучше того, как он решает проблему сейчас?',
          help_md:
            'Измеримая выгода для клиента (время, деньги, риск) и почему ему стоит менять привычку. Сравнивайте с ответом «Как клиент решает проблему сейчас», а не с идеальным конкурентом.',
          example_good_md:
            'Сервис перестаёт терять записи (+8–12 в неделю) и тратить время приёмщика на телефон (~1,5 ч в день). Против YClients — настройка за 15 минут вместо двух дней и цена вдвое ниже',
          example_weak_md: 'Удобнее, быстрее и дешевле аналогов',
        },
      },
    },
    {
      key: 'product_status',
      section: 'solution',
      order: 30,
      type: 'select',
      options: [
        {
          code: 'nothing_yet',
          texts: {
            'ru-RU': {
              label: 'Продукта ещё нет',
            },
          },
        },
        {
          code: 'prototype',
          texts: {
            'ru-RU': {
              label: 'Прототип или макет, им не пользуются',
            },
          },
        },
        {
          code: 'working_mvp',
          texts: {
            'ru-RU': {
              label: 'Работающая версия, ею пользуются',
            },
          },
        },
        {
          code: 'product_in_use',
          texts: {
            'ru-RU': {
              label: 'Продукт в регулярном использовании у клиентов',
            },
          },
        },
        {
          code: 'mature_product',
          texts: {
            'ru-RU': {
              label: 'Зрелый продукт, развивается по плану',
            },
          },
        },
      ],
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      texts: {
        'ru-RU': {
          label: 'Что существует сейчас?',
          help_md: 'По состоянию на сегодня.',
        },
      },
    },
    {
      key: 'product_works_now',
      section: 'solution',
      order: 40,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Что реально работает сегодня и кто этим пользуется?',
          help_md:
            'Перечислите то, что можно показать и потрогать, и кто это делает регулярно. Что говорят пользователи — что хвалят, на что жалуются. Что в разработке — отдельно и честно.',
          example_good_md:
            'Работает: запись по ссылке, календарь, SMS-напоминания. Пользуются 4 сервиса в Казани с апреля, ~300 записей в месяц. Жалуются на отсутствие интеграции с 1С — в разработке. Не начато: оплата онлайн',
          example_weak_md: 'Всё работает, пользователи довольны',
        },
      },
    },
    {
      key: 'demo',
      section: 'solution',
      order: 50,
      type: 'material_ref',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxItems: 3,
      },
      texts: {
        'ru-RU': {
          label: 'Демо, видео или ссылка на продукт',
          help_md:
            'Ссылка на продукт, короткое видео (до 3 минут) или тестовый доступ. Для железа — видео работы прототипа.',
        },
      },
    },
    {
      key: 'trl_level',
      section: 'solution',
      order: 60,
      type: 'select',
      options: [
        {
          code: 'trl_1_3',
          texts: {
            'ru-RU': {
              label: 'Идея и лабораторное подтверждение',
            },
          },
        },
        {
          code: 'trl_4_6',
          texts: {
            'ru-RU': {
              label: 'Прототип в лаборатории или в приближённых условиях',
            },
          },
        },
        {
          code: 'trl_7_8',
          texts: {
            'ru-RU': {
              label: 'Прототип в реальных условиях, система готова',
            },
          },
        },
        {
          code: 'trl_9',
          texts: {
            'ru-RU': {
              label: 'Серийная эксплуатация',
            },
          },
        },
      ],
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'hidden',
        growth: 'hidden',
      },
      visibility: 'investors',
      texts: {
        'ru-RU': {
          label: 'Уровень технологической готовности (TRL)',
          help_md:
            'По шкале TRL; если не уверены — выберите ближайшее и поясните в предыдущем вопросе.',
        },
      },
    },
    {
      key: 'own_technology',
      section: 'solution',
      order: 70,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Есть ли собственная технология или уникальные наработки?',
          help_md:
            'Что именно ваше: алгоритм, данные, конструкция, процесс. Чем это подтверждается — патент, публикация, результаты замеров. Если своего нет и продукт собран из готовых компонентов — так и напишите, это нормально для многих моделей.',
          example_good_md:
            'Собственный алгоритм распределения записей по постам с учётом длительности работ; накоплено 12 тыс. размеченных заказ-нарядов. Патента нет, подана заявка № … (приложена)',
          example_weak_md: 'Уникальный ИИ, аналогов нет',
        },
      },
    },
    {
      key: 'external_dependencies',
      section: 'solution',
      order: 80,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'От каких внешних платформ, поставщиков, данных или разрешений зависит продукт?',
          help_md:
            'То, без чего продукт остановится: чужой API, единственный поставщик, магазин приложений, лицензия. И что будете делать, если это исчезнет.',
          example_good_md:
            'SMS через одного провайдера (есть запасной), карты — Яндекс (бесплатный лимит хватает до 1 000 сервисов), App Store и Google Play',
          example_weak_md: 'Ни от чего не зависим',
        },
      },
    },
    {
      key: 'roadmap_next',
      section: 'solution',
      order: 90,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Ближайший план развития продукта (3–6 месяцев)',
          help_md:
            'Три-пять пунктов с ориентировочными сроками. Что из этого зависит от инвестиций — скажете в разделе «Инвестиционный запрос».',
          example_good_md:
            'Октябрь — интеграция с 1С; ноябрь — онлайн-оплата; до конца года — версия для сетей из нескольких точек',
          example_weak_md: 'Развитие функционала и масштабирование',
        },
      },
    },
    {
      key: 'traction_summary',
      section: 'traction',
      order: 10,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Каких результатов вы уже достигли?',
          help_md:
            '3–7 фактов с цифрами и датами: пользователи, клиенты, выручка, пилоты, письма о намерениях, партнёрства. На стадии идеи — первые подтверждения: предзаказы, договорённости о пилоте, лист ожидания. Приложите выгрузку, скриншот или письмо там, где утверждение сильное.',
          example_good_md:
            'Апрель — первые 4 сервиса; июль — 11 сервисов, из них 6 платят по 1 990 ₽/мес; за август 1 340 записей через продукт; подписано письмо о намерениях с сетью из 9 точек (приложено)',
          example_weak_md: 'Есть первые клиенты, отличные отзывы, быстро растём',
        },
      },
    },
    {
      key: 'users_total',
      section: 'traction',
      order: 20,
      type: 'number',
      stages: {
        idea: 'hidden',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        min: 0,
        max: 1000000000,
      },
      texts: {
        'ru-RU': {
          label: 'Сколько всего людей или компаний попробовали продукт?',
          help_md: 'За всё время, включая тех, кто ушёл. Число.',
        },
      },
    },
    {
      key: 'active_users',
      section: 'traction',
      order: 30,
      type: 'number',
      stages: {
        idea: 'hidden',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        min: 0,
        max: 1000000000,
      },
      texts: {
        'ru-RU': {
          label: 'Сколько пользуются продуктом регулярно?',
          help_md:
            'За последний месяц. Для потребительских продуктов — MAU и, если считаете, DAU через дробь («12 000 / 2 100»); для компаний — число активных клиентов.',
        },
      },
    },
    {
      key: 'paying_customers',
      section: 'traction',
      order: 40,
      type: 'number',
      stages: {
        idea: 'hidden',
        mvp: 'recommended',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        min: 0,
        max: 1000000000,
      },
      texts: {
        'ru-RU': {
          label: 'Сколько клиентов платят?',
          help_md: 'Сейчас, а не за всё время. Пилоты за деньги считаются, бесплатные — нет.',
        },
      },
    },
    {
      key: 'pilots',
      section: 'traction',
      order: 50,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Пилоты, тестовые внедрения, письма о намерениях, партнёрства',
          help_md:
            'С кем, на какой стадии, платный ли, чем закончится и когда. Партнёрство без действий — не результат; приложите документ, если есть.',
          example_good_md:
            'Пилот с сетью „Автоплюс“ (9 точек) с 1 сентября, бесплатно 2 месяца, критерий успеха — 500 записей/мес; LOI на подключение 30 точек при успехе (приложено)',
          example_weak_md: 'Ведём переговоры с крупными сетями',
        },
      },
    },
    {
      key: 'revenue_last_12m',
      section: 'traction',
      order: 60,
      type: 'money',
      stages: {
        idea: 'hidden',
        mvp: 'recommended',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      evidence: true,
      texts: {
        'ru-RU': {
          label: 'Выручка за последние 12 месяцев',
          help_md:
            'Фактически полученные деньги от клиентов, в рублях, без грантов и инвестиций. Если продукт живёт меньше года — за фактический срок, напишите срок в «Результатах».',
        },
      },
    },
    {
      key: 'mrr',
      section: 'traction',
      order: 70,
      type: 'money',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'hidden',
        growth: 'hidden',
      },
      visibility: 'investors',
      evidence: true,
      texts: {
        'ru-RU': {
          label: 'Ежемесячная регулярная выручка (MRR)',
          help_md:
            'Сумма подписок за последний полный месяц; разовые платежи не включайте. Годовая (ARR) = MRR × 12, отдельно не спрашиваем.',
        },
      },
    },
    {
      key: 'gmv_monthly',
      section: 'traction',
      order: 80,
      type: 'money',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'hidden',
        growth: 'hidden',
      },
      visibility: 'investors',
      evidence: true,
      texts: {
        'ru-RU': {
          label: 'Оборот площадки за месяц (GMV)',
          help_md:
            'Сумма всех сделок через площадку за последний полный месяц — до вычета вашей комиссии. Ваша выручка — в вопросе о выручке.',
        },
      },
    },
    {
      key: 'acv',
      section: 'traction',
      order: 90,
      type: 'money',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'hidden',
        growth: 'hidden',
      },
      visibility: 'investors',
      evidence: true,
      texts: {
        'ru-RU': {
          label: 'Средний годовой контракт (ACV)',
          help_md:
            'Средняя сумма одного контракта в год по действующим клиентам. Если контракты сильно различаются — укажите диапазон в «Результатах».',
        },
      },
    },
    {
      key: 'growth_rate',
      section: 'traction',
      order: 100,
      type: 'text',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'recommended',
        growth: 'mandatory',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 200,
      },
      texts: {
        'ru-RU': {
          label: 'Рост за последние 3–6 месяцев',
          help_md:
            'По главному показателю (выручка, активные пользователи, оборот) — месяц к месяцу или квартал к кварталу, с указанием показателя.',
          example_good_md: 'MRR: +18% в месяц в среднем за июнь–август (42 → 69 тыс. ₽)',
          example_weak_md: 'Растём кратно',
        },
      },
    },
    {
      key: 'retention',
      section: 'traction',
      order: 110,
      type: 'text',
      stages: {
        idea: 'hidden',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'mandatory',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 200,
      },
      texts: {
        'ru-RU': {
          label: 'Удержание клиентов',
          help_md:
            'Для подписки — отток в месяц; для потребительского продукта — доля пользователей, вернувшихся через 1 и 3 месяца; для маркетплейса — доля повторных заказов; для enterprise — доля продлений. Укажите, что именно считаете.',
          example_good_md: 'Отток 4% в месяц по клиентам за июнь–август; из 11 подключённых ушёл 1',
          example_weak_md: 'Клиенты не уходят',
        },
      },
    },
    {
      key: 'pipeline',
      section: 'traction',
      order: 120,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Воронка продаж',
          help_md:
            'Сколько сделок в работе, на каких стадиях, ожидаемая сумма и сроки. Если воронки нет — напишите, как ищете клиентов сейчас.',
          example_good_md:
            '14 сервисов после демо, 6 в пробном периоде, 3 согласуют договор; ожидаемо +7 клиентов до конца октября (~14 тыс. ₽ MRR)',
          example_weak_md: 'Много заинтересованных',
        },
      },
    },
    {
      key: 'hypotheses_tested',
      section: 'traction',
      order: 130,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'mandatory',
        early_revenue: 'recommended',
        growth: 'hidden',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Какие гипотезы вы проверили — что подтвердилось, а что нет?',
          help_md:
            'Гипотеза → как проверяли → результат. Опровергнутые гипотезы ценятся не меньше подтверждённых: они показывают, что вы учитесь на данных.',
          example_good_md:
            '„Сервисы будут платить за напоминания клиентам“ — да, 6 из 11 включили платный тариф. „Клиенты сервисов сами скачают приложение“ — нет, установили 8%, перешли на запись по ссылке без установки',
          example_weak_md: 'Все гипотезы подтвердились',
        },
      },
    },
    {
      key: 'market_segment',
      section: 'market',
      order: 10,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'На каком рынке и в каком сегменте вы работаете?',
          help_md: 'Рынок словами, как его назвал бы клиент, и ваш сегмент внутри него.',
          example_good_md:
            'Программы для записи и учёта в независимых автосервисах России; сегмент — сервисы на 2–6 постов',
          example_weak_md: 'Автомобильный рынок и IT',
        },
      },
    },
    {
      key: 'market_size',
      section: 'market',
      order: 20,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Каков размер рынка и как вы его оценили?',
          help_md:
            'Цифры с методом расчёта и источниками. Если считали снизу вверх — покажите множители. TAM/SAM/SOM — только если можете обосновать каждую цифру. Приложите источник или расчёт.',
          example_good_md:
            'В России ~38 тыс. независимых сервисов (реестр ФНС по ОКВЭД 45.20, 2025), из них ~22 тыс. на 2–6 постов. При 2 000 ₽/мес — 530 млн ₽ в год; достижимая доля за 3 года — 8% (1 800 сервисов), 43 млн ₽/год',
          example_weak_md: 'Рынок огромный, миллиарды долларов, растёт на 30% в год',
        },
      },
    },
    {
      key: 'market_dynamics',
      section: 'market',
      order: 30,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Как меняется рынок?',
          help_md:
            'Растёт, стоит или сжимается, что его двигает или тормозит: регулирование, технологии, поведение клиентов.',
          example_good_md:
            'Число сервисов стабильно; растёт доля клиентов, которые записываются онлайн (по данным Авто.ру — с 12% в 2023 до 27% в 2025)',
          example_weak_md: 'Рынок динамично развивается',
        },
      },
    },
    {
      key: 'why_now',
      section: 'market',
      order: 40,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Почему именно сейчас?',
          help_md:
            'Что изменилось в последние год-два, из-за чего этот продукт стал возможен или нужен, и почему его не сделали раньше.',
          example_good_md:
            'После ухода зарубежных сервисов записи сервисы остались с 1С и тетрадью; SMS подешевели втрое; у 90% приёмщиков смартфон',
          example_weak_md: 'Сейчас самое время для цифровизации',
        },
      },
    },
    {
      key: 'competitors_direct',
      section: 'competition',
      order: 10,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Кто ваши прямые конкуренты и чем вы отличаетесь?',
          help_md:
            'Три-пять названий с одной строкой: что у них хорошо, что плохо, чем вы отличаетесь. Как клиент обходится без продуктов вообще — вы уже описали в «Проблеме».',
          example_good_md:
            'YClients — лидер, сильный в салонах красоты, для сервисов избыточен и дорог (2 900 ₽). Автодилер — учёт для дилеров, не для малых сервисов. Мы — только запись и посты, настройка за 15 минут, 1 990 ₽',
          example_weak_md: 'Прямых конкурентов нет',
        },
      },
    },
    {
      key: 'competitors_indirect',
      section: 'competition',
      order: 20,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Косвенные конкуренты и заменители',
          help_md:
            'Продукты из соседних категорий, которые клиент может приспособить под задачу, и кто может прийти на ваш рынок.',
          example_good_md:
            'Google Календарь и Telegram-боты для записи; из крупных могут прийти Авто.ру и Яндекс — у них есть трафик, нет учёта постов',
          example_weak_md: 'Нет',
        },
      },
    },
    {
      key: 'competitive_advantage',
      section: 'competition',
      order: 30,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'В чём ваше преимущество и чем оно защищено?',
          help_md:
            'Почему клиент выберет вас и почему конкурент не повторит это за полгода. Преимущество должно опираться на факты: технология, данные, доступ к клиентам, экспертиза, стоимость. Приложите подтверждение, если утверждение сильное (патент, эксклюзивный договор).',
          example_good_md:
            'Единственная интеграция с каталогом запчастей Autodoc — эксклюзив до 2028 (договор приложен); 12 тыс. размеченных заказ-нарядов для оценки длительности работ; основатель 6 лет в отрасли, 40 сервисов в личных контактах',
          example_weak_md: 'Уникальная технология и сильная команда',
        },
      },
    },
    {
      key: 'defensibility_types',
      section: 'competition',
      order: 40,
      type: 'multiselect',
      options: [
        {
          code: 'ip',
          texts: {
            'ru-RU': {
              label: 'Патенты и права',
            },
          },
        },
        {
          code: 'proprietary_data',
          texts: {
            'ru-RU': {
              label: 'Собственные данные',
            },
          },
        },
        {
          code: 'network_effects',
          texts: {
            'ru-RU': {
              label: 'Сетевой эффект',
            },
          },
        },
        {
          code: 'distribution',
          texts: {
            'ru-RU': {
              label: 'Доступ к клиентам, каналы',
            },
          },
        },
        {
          code: 'domain_expertise',
          texts: {
            'ru-RU': {
              label: 'Экспертиза в отрасли',
            },
          },
        },
        {
          code: 'cost_advantage',
          texts: {
            'ru-RU': {
              label: 'Структурно ниже стоимость',
            },
          },
        },
        {
          code: 'regulatory',
          texts: {
            'ru-RU': {
              label: 'Лицензии, допуски',
            },
          },
        },
        {
          code: 'switching_costs',
          texts: {
            'ru-RU': {
              label: 'Клиенту дорого уйти',
            },
          },
        },
        {
          code: 'none_yet',
          texts: {
            'ru-RU': {
              label: 'Пока ничего',
            },
          },
        },
      ],
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      texts: {
        'ru-RU': {
          label: 'Что защищает ваше преимущество?',
          help_md:
            'Отметьте только то, что уже есть и раскрыто в ответе выше. Отметка сама по себе ничего не доказывает.',
        },
      },
    },
    {
      key: 'revenue_model',
      section: 'business_model',
      order: 10,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Кто платит, за что и сколько?',
          help_md:
            'Модель дохода (подписка, комиссия, разовая продажа, лицензия), цены или тарифы, что входит. Если цену ещё не проверяли на клиентах — напишите, какую собираетесь проверить.',
          example_good_md:
            'Подписка сервиса: 1 990 ₽/мес за точку (запись + календарь), +990 ₽ за напоминания клиентам. Пробный период 14 дней. Клиенты сервиса не платят',
          example_weak_md: 'Монетизация через подписку и рекламу',
        },
      },
    },
    {
      key: 'acquisition_channels',
      section: 'business_model',
      order: 20,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Как вы привлекаете клиентов сейчас и как будете дальше?',
          help_md:
            'Каналы, которые уже работают, с цифрами (сколько клиентов и во сколько обошёлся каждый), и те, что планируете проверить. Если клиентов ещё нет — как будете искать первых десять.',
          example_good_md:
            'Сейчас: личные контакты основателя — 7 клиентов, стоимость ~0; выезд по сервисам района — 4 клиента за 3 недели, ~2 000 ₽ за клиента. Планируем: партнёрство с поставщиками запчастей (у них база сервисов)',
          example_weak_md: 'Таргетированная реклама, соцсети, сарафанное радио',
        },
      },
    },
    {
      key: 'sales_cycle',
      section: 'business_model',
      order: 30,
      type: 'text',
      stages: {
        idea: 'hidden',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 200,
      },
      texts: {
        'ru-RU': {
          label: 'Сколько длится продажа?',
          help_md: 'От первого контакта до первой оплаты, типичный срок и разброс.',
          example_good_md: '2–4 недели; сети — 2–3 месяца из-за согласования',
          example_weak_md: 'Быстро',
        },
      },
    },
    {
      key: 'acquisition_scalability',
      section: 'business_model',
      order: 40,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'recommended',
        growth: 'mandatory',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Какие каналы дают повторяемый результат и по какой цене?',
          help_md:
            'Канал → стоимость привлечения → сколько клиентов в месяц он может дать при увеличении бюджета, и где упирается.',
          example_good_md:
            'Холодные выезды: 2 000–2 500 ₽ за клиента, один менеджер даёт 6–8 клиентов в месяц; масштабируется наймом до ~5 менеджеров на регион. Контекстная реклама: 6 000 ₽ за клиента, невыгодно при текущем чеке',
          example_weak_md: 'При увеличении бюджета рост будет пропорциональным',
        },
      },
    },
    {
      key: 'key_partners',
      section: 'business_model',
      order: 50,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Критичные партнёры',
          help_md:
            'Без кого модель не работает: поставщики, каналы, интеграции. Стадия отношений: договор, договорённость, идея. Приложите договор, если утверждение важно для оценки.',
          example_good_md:
            'Autodoc — интеграция с каталогом, договор до 2028 (приложен); СМС-провайдер — договор; сеть „Автоплюс“ — пилот',
          example_weak_md: 'Планируем партнёрства с лидерами рынка',
        },
      },
    },
    {
      key: 'founders',
      section: 'team',
      order: 10,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Кто основатели?',
          help_md:
            'По каждому: имя, роль в проекте, чем занимается ежедневно, опыт в двух строках, ссылка на профиль. Доли — в разделе «Юридическая готовность».',
          example_good_md:
            'Иван Петров, CEO, продажи и продукт: 6 лет владел автосервисом на 4 поста, до этого — руководитель отдела продаж в дилерском центре. Мария Сидорова, CTO, разработка: 8 лет в бэкенде, техлид в …',
          example_weak_md: 'Опытная команда профессионалов с горящими глазами',
        },
      },
    },
    {
      key: 'founders_commitment',
      section: 'team',
      order: 20,
      type: 'select',
      options: [
        {
          code: 'all_full_time',
          texts: {
            'ru-RU': {
              label: 'Все основатели полностью в проекте',
            },
          },
        },
        {
          code: 'partly',
          texts: {
            'ru-RU': {
              label: 'Часть основателей полностью, часть — совмещает',
            },
          },
        },
        {
          code: 'all_part_time',
          texts: {
            'ru-RU': {
              label: 'Все совмещают с другой работой',
            },
          },
        },
      ],
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      texts: {
        'ru-RU': {
          label: 'Сколько времени основатели уделяют проекту?',
          help_md:
            'По факту на сегодня. Если планируете перейти в проект после раунда — скажите об этом в «На что пойдут инвестиции».',
        },
      },
    },
    {
      key: 'domain_expertise',
      section: 'team',
      order: 30,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Почему именно вы?',
          help_md:
            'Связь основателей с проблемой и рынком: работали в отрасли, сами были клиентом, имеете доступ к клиентам или уникальные знания.',
          example_good_md:
            'CEO 6 лет управлял сервисом и лично терял записи; знает 40 владельцев сервисов по имени. CTO делала систему записи для клиники — та же задача в другой отрасли',
          example_weak_md: 'Мы увлечены темой и много читали о рынке',
        },
      },
    },
    {
      key: 'track_record',
      section: 'team',
      order: 40,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Что вы делали раньше и чем это закончилось?',
          help_md:
            'Предыдущие проекты и продукты: ваша роль, до какой стадии довели, результат в цифрах, что пошло не так и чему научились. Неуспех с разбором — сильнее, чем список должностей.',
          example_good_md:
            '2019–2022: сервис доставки запчастей, сооснователь, дошли до 3 млн ₽/мес выручки, закрылись из-за зависимости от одного поставщика — теперь всегда держим запасного. 2023: вывел продукт X в компании Y от нуля до 2 000 клиентов за год',
          example_weak_md: 'Участвовал в нескольких успешных стартапах',
        },
      },
    },
    {
      key: 'team_size_and_roles',
      section: 'team',
      order: 50,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Кто в команде помимо основателей?',
          help_md:
            'Число людей, роли, в штате или по договору, полная или частичная занятость. Ключевые люди — по имени.',
          example_good_md:
            '5 человек: 2 разработчика в штате, дизайнер и тестировщик по договору, менеджер по продажам в штате с августа',
          example_weak_md: 'Команда из 20 специалистов',
        },
      },
    },
    {
      key: 'capability_gaps',
      section: 'team',
      order: 60,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Каких компетенций не хватает и как вы их закрываете?',
          help_md:
            'Честно: продажи, маркетинг, разработка, производство, финансы, отрасль. Кем и когда закроете: наём, партнёр, советник.',
          example_good_md:
            'Нет опыта продаж сетям — ведём переговоры с советником из „Автоплюса“; нет финансиста — на аутсорсе до серии A',
          example_weak_md: 'Команда закрывает все компетенции',
        },
      },
    },
    {
      key: 'planning_tool',
      section: 'execution',
      order: 10,
      type: 'select',
      options: [
        {
          code: 'jira',
          texts: {
            'ru-RU': {
              label: 'Jira',
            },
          },
        },
        {
          code: 'notion',
          texts: {
            'ru-RU': {
              label: 'Notion',
            },
          },
        },
        {
          code: 'trello',
          texts: {
            'ru-RU': {
              label: 'Trello',
            },
          },
        },
        {
          code: 'obsidian',
          texts: {
            'ru-RU': {
              label: 'Obsidian',
            },
          },
        },
        {
          code: 'github_projects',
          texts: {
            'ru-RU': {
              label: 'GitHub Projects',
            },
          },
        },
        {
          code: 'ms_project',
          texts: {
            'ru-RU': {
              label: 'MS Project',
            },
          },
        },
        {
          code: 'spreadsheets',
          texts: {
            'ru-RU': {
              label: 'Таблицы',
            },
          },
        },
        {
          code: 'mind_maps',
          texts: {
            'ru-RU': {
              label: 'Интеллект-карты',
            },
          },
        },
        {
          code: 'other',
          texts: {
            'ru-RU': {
              label: 'Другое',
            },
          },
        },
        {
          code: 'none',
          texts: {
            'ru-RU': {
              label: 'Нигде, в голове',
            },
          },
        },
      ],
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      texts: {
        'ru-RU': {
          label: 'Где вы ведёте задачи и планы?',
          help_md: 'Как есть. Выбор не влияет на оценку — важен следующий вопрос.',
        },
      },
    },
    {
      key: 'work_cycle',
      section: 'execution',
      order: 20,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Как организована работа над проектом?',
          help_md:
            'Где план, как решаете, что делать в первую очередь, как фиксируете сделанное, как часто пересматриваете план и кто в этом участвует.',
          example_good_md:
            'Квартальный план из 3–4 целей в Notion; еженедельно разбираем задачи на неделю, в пятницу — что сделано; раз в месяц пересматриваем цели по данным продаж',
          example_weak_md: 'Работаем гибко, по Agile',
        },
      },
    },
    {
      key: 'last_period_results',
      section: 'execution',
      order: 30,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Что планировали на последние три месяца и что из этого сделано?',
          help_md:
            'План → факт, включая то, что не сделано, и почему. Приложите скриншот доски, отчёт или ссылку — это лучшее подтверждение способности исполнять.',
          example_good_md:
            'Планировали: интеграция 1С, 15 платящих, найм продавца. Сделано: продавец с августа, 11 платящих (не 15 — пробный период оказался длиннее), 1С перенесена на октябрь из-за смены приоритета на напоминания',
          example_weak_md: 'Все планы выполнены, движемся по графику',
        },
      },
    },
    {
      key: 'roadmap_link',
      section: 'execution',
      order: 40,
      type: 'url',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      texts: {
        'ru-RU': {
          label: 'Ссылка на план, репозиторий или другой артефакт работы',
          help_md:
            'Публичная или доступная по ссылке страница: roadmap, доска, GitHub, документ. Необязательно.',
        },
      },
    },
    {
      key: 'monthly_burn',
      section: 'economics',
      order: 10,
      type: 'money',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      texts: {
        'ru-RU': {
          label: 'Сколько проект тратит в месяц?',
          help_md:
            'Все расходы за типичный месяц, включая зарплаты основателей, если они есть. Основные статьи перечислите в «Прогнозе» или в подсказке к сумме. Если тратите только своё время — укажите 0 и скажите об этом в «Основателях».',
        },
      },
    },
    {
      key: 'runway_current_months',
      section: 'economics',
      order: 20,
      type: 'number',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        min: 0,
        max: 999,
      },
      texts: {
        'ru-RU': {
          label: 'На сколько месяцев хватает текущих средств?',
          help_md:
            'При текущих расходах и без новых инвестиций. Целое число месяцев; если расходы покрываются выручкой — 99.',
        },
      },
    },
    {
      key: 'profitability',
      section: 'economics',
      order: 30,
      type: 'select',
      options: [
        {
          code: 'loss_making',
          texts: {
            'ru-RU': {
              label: 'Убыток',
            },
          },
        },
        {
          code: 'breakeven',
          texts: {
            'ru-RU': {
              label: 'В ноль',
            },
          },
        },
        {
          code: 'profitable',
          texts: {
            'ru-RU': {
              label: 'Прибыль',
            },
          },
        },
      ],
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      texts: {
        'ru-RU': {
          label: 'Прибыльность',
          help_md: 'По операционной деятельности за последний квартал.',
        },
      },
    },
    {
      key: 'unit_economics',
      section: 'economics',
      order: 40,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'mandatory',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Юнит-экономика',
          help_md:
            'Сколько стоит привлечь одного клиента (CAC), сколько он приносит за время жизни (LTV), за сколько месяцев окупается. Укажите период и метод. На стадии MVP — гипотеза с расчётом; приложите таблицу, если есть.',
          example_good_md:
            'CAC 2 300 ₽ (холодные выезды, июнь–август), средний чек 2 400 ₽/мес, отток 4% → LTV ~60 000 ₽, окупаемость 1 месяц. Расчёт приложен',
          example_weak_md: 'Экономика сходится, LTV сильно больше CAC',
        },
      },
    },
    {
      key: 'gross_margin',
      section: 'economics',
      order: 50,
      type: 'number',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        min: 0,
        max: 100,
      },
      texts: {
        'ru-RU': {
          label: 'Валовая маржа, %',
          help_md:
            '(выручка − прямые затраты на оказание услуги или производство) / выручка, за последний квартал. От 0 до 100; отрицательную укажите как 0 и поясните в юнит-экономике.',
        },
      },
    },
    {
      key: 'take_rate',
      section: 'economics',
      order: 60,
      type: 'number',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'hidden',
        growth: 'hidden',
      },
      visibility: 'investors',
      constraints: {
        min: 0,
        max: 100,
      },
      texts: {
        'ru-RU': {
          label: 'Комиссия площадки, %',
          help_md: 'Ваша доля от оборота (GMV), средняя за последний месяц.',
        },
      },
    },
    {
      key: 'unit_cost',
      section: 'economics',
      order: 70,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'hidden',
        growth: 'hidden',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Себестоимость единицы и целевая цена',
          help_md:
            'Стоимость материалов и сборки одного изделия сейчас (BOM) и при серии, целевая цена продажи. Приложите расчёт BOM, если есть.',
          example_good_md:
            'BOM прототипа 41 000 ₽; при серии 500 шт — 18 500 ₽ (КП поставщиков приложены); целевая цена 59 000 ₽',
          example_weak_md: 'Себестоимость будет низкой при масштабировании',
        },
      },
    },
    {
      key: 'manufacturing',
      section: 'economics',
      order: 80,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'hidden',
        growth: 'hidden',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Производство и цепочка поставок',
          help_md:
            'Кто и где производит (сами, контрактно), какие объёмы возможны, критичные компоненты и их поставщики, сертификация, что уже сделано.',
          example_good_md:
            'Сборка на контрактном производстве в Зеленограде, пробная партия 20 шт собрана в августе; контроллер — единственный поставщик, ищем второй; сертификация ЕАС — подана',
          example_weak_md: 'Производство наладим после инвестиций',
        },
      },
    },
    {
      key: 'forecast_summary',
      section: 'economics',
      order: 90,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'recommended',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Прогноз на 12–24 месяца',
          help_md:
            'Выручка, расходы и клиенты по кварталам, три-четыре ключевых допущения, на которых прогноз стоит. Файл модели — следующим вопросом.',
          example_good_md:
            'К концу 2027: 900 сервисов, MRR 2,1 млн ₽, расходы 1,6 млн ₽/мес. Допущения: CAC ≤ 3 000 ₽, отток ≤ 5%, 4 продавца с ноября',
          example_weak_md: 'Выход на 100 млн выручки через два года',
        },
      },
    },
    {
      key: 'financial_model',
      section: 'economics',
      order: 100,
      type: 'material_ref',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxItems: 1,
      },
      texts: {
        'ru-RU': {
          label: 'Финансовая модель',
          help_md:
            'Таблица с помесячным прогнозом и допущениями. Формат — любой из поддерживаемых материалами.',
        },
      },
    },
    {
      key: 'funding_scope',
      section: 'funding',
      order: 10,
      type: 'select',
      options: [
        {
          code: 'project',
          texts: {
            'ru-RU': {
              label: 'На проект в целом',
            },
          },
        },
        {
          code: 'direction',
          texts: {
            'ru-RU': {
              label: 'На конкретное направление, продукт или этап',
            },
          },
        },
      ],
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'public',
      coreField: 'funding_scope',
      texts: {
        'ru-RU': {
          label: 'На что вы привлекаете инвестиции?',
          help_md:
            'Если деньги нужны на отдельное направление («запуск в Казахстане», «второй продукт»), выберите второе и назовите его — так инвестор поймёт, что оценивать.',
        },
      },
    },
    {
      key: 'funding_scope_note',
      section: 'funding',
      order: 20,
      type: 'text',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'public',
      constraints: {
        maxLength: 200,
      },
      coreField: 'funding_scope_note',
      texts: {
        'ru-RU': {
          label: 'Какое направление или этап?',
          help_md:
            'Два-пять слов, как назвали бы его сами: «Выход на рынок Казахстана», «Серийное производство», «Модуль для сетей».',
          example_good_md: 'Запуск направления грузовых сервисов',
          example_weak_md: 'Развитие',
        },
      },
    },
    {
      key: 'investment_ask',
      section: 'funding',
      order: 30,
      type: 'money',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'public',
      coreField: 'investment_ask',
      texts: {
        'ru-RU': {
          label: 'Сколько вы привлекаете?',
          help_md:
            'Сумма в рублях на этот раунд. Потолок суммы на заявку задан политикой платформы и показан рядом.',
        },
      },
    },
    {
      key: 'round_type',
      section: 'funding',
      order: 40,
      type: 'select',
      options: [
        {
          code: 'pre_seed',
          texts: {
            'ru-RU': {
              label: 'Pre-seed',
            },
          },
        },
        {
          code: 'seed',
          texts: {
            'ru-RU': {
              label: 'Seed',
            },
          },
        },
        {
          code: 'series_a',
          texts: {
            'ru-RU': {
              label: 'Серия A',
            },
          },
        },
        {
          code: 'series_b_plus',
          texts: {
            'ru-RU': {
              label: 'Серия B и позже',
            },
          },
        },
        {
          code: 'bridge',
          texts: {
            'ru-RU': {
              label: 'Промежуточный',
            },
          },
        },
        {
          code: 'grant_or_other',
          texts: {
            'ru-RU': {
              label: 'Грант или иное',
            },
          },
        },
        {
          code: 'not_defined',
          texts: {
            'ru-RU': {
              label: 'Не определён',
            },
          },
        },
      ],
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      texts: {
        'ru-RU': {
          label: 'Раунд привлечения',
          help_md: 'Если не знаете, как назвать, — `not_defined`; это не влияет на рассмотрение.',
        },
      },
    },
    {
      key: 'ask_rationale',
      section: 'funding',
      order: 50,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Почему именно такая сумма?',
          help_md:
            'Как сумма связана с планом: из расходов на срок, из стоимости конкретных работ, из следующего рубежа, после которого проект стоит дороже.',
          example_good_md:
            '12 месяцев работы при расходах 1,2 млн ₽/мес после найма 3 продавцов и 1 разработчика, плюс 20% запас = 17 млн ₽; за это время выходим на 900 сервисов, что делает возможным раунд A',
          example_weak_md: 'Столько нужно для масштабирования',
        },
      },
    },
    {
      key: 'use_of_funds',
      section: 'funding',
      order: 60,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'На что пойдут инвестиции?',
          help_md:
            'Статьи расходов с долями или суммами: люди, маркетинг, разработка, производство, запас. Сумма долей — 100%.',
          example_good_md:
            'Команда продаж — 45% (3 менеджера, 12 мес), разработка — 25% (1 разработчик + интеграции), маркетинг — 15%, операционные и юр. — 10%, резерв — 5%',
          example_weak_md: 'Маркетинг, разработка, команда',
        },
      },
    },
    {
      key: 'runway_with_funds_months',
      section: 'funding',
      order: 70,
      type: 'number',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        min: 1,
        max: 999,
      },
      texts: {
        'ru-RU': {
          label: 'На сколько месяцев хватит этих средств?',
          help_md:
            'Целое число месяцев при запланированных расходах. Инвестор сверит с суммой и расходами.',
        },
      },
    },
    {
      key: 'milestones',
      section: 'funding',
      order: 80,
      type: 'textarea',
      stages: {
        idea: 'mandatory',
        mvp: 'mandatory',
        early_revenue: 'mandatory',
        growth: 'mandatory',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Каких результатов вы достигнете на эти деньги и к какому сроку?',
          help_md:
            'Три-пять измеримых результатов с датами и каким станет проект после: клиенты, выручка, продукт, команда. Это обещание, по которому инвестор будет вас мерить.',
          example_good_md:
            'К 06.2027: 400 платящих сервисов, MRR 900 тыс. ₽, интеграции с 1С и Autodoc; к 12.2027: 900 сервисов, MRR 2,1 млн ₽, выход в ноль; проект готов к раунду A на 60–80 млн ₽',
          example_weak_md: 'Рост базы клиентов и выход на новые рынки',
        },
      },
    },
    {
      key: 'next_round',
      section: 'funding',
      order: 90,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Что дальше?',
          help_md:
            'Понадобится ли следующий раунд, когда, примерно сколько и на что; или план дойти до прибыльности на эти деньги.',
          example_good_md:
            'Раунд A в начале 2028 на 60–80 млн ₽ под выход в 5 регионов; при отставании от плана — выход в ноль к 12.2027 без раунда',
          example_weak_md: 'Посмотрим по ситуации',
        },
      },
    },
    {
      key: 'previous_funding',
      section: 'traction',
      order: 140,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Что вы уже привлекали?',
          help_md:
            'Собственные средства, гранты, ангелы, фонды, займы: сумма, источник, дата, условия в общих чертах. Если ничего — так и напишите, включая свои вложения.',
          example_good_md:
            'Свои средства основателей — 1,8 млн ₽ (2025–2026); грант ФСИ «Студенческий стартап» — 1 млн ₽ (03.2026); внешних инвесторов нет',
          example_weak_md: 'Есть',
        },
      },
    },
    {
      key: 'deal_terms',
      section: 'funding',
      order: 110,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Условия сделки, если они уже сформулированы',
          help_md:
            'Ожидаемая доля или оценка, инструмент (доля, конвертируемый заём, опцион). Необязательно: можно обсуждать с инвестором напрямую.',
          example_good_md: 'Готовы отдать 15–20% за 17 млн ₽; предпочтительно доля в ООО',
          example_weak_md: 'По договорённости',
        },
      },
    },
    {
      key: 'key_assumptions',
      section: 'risks',
      order: 10,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Что должно оказаться верным, чтобы план сработал?',
          help_md:
            'Три-пять предположений, которые ещё не доказаны, и как вы будете их проверять. Если предположение уже подтверждено фактами — это результат, ему место в «Результатах».',
          example_good_md:
            '1) Сети сервисов купят при цене 1 500 ₽ за точку — проверим пилотом с „Автоплюсом“ до ноября. 2) Холодные выезды масштабируются до 5 менеджеров без падения конверсии — проверим наймом второго в октябре',
          example_weak_md: 'Рынок примет продукт',
        },
      },
    },
    {
      key: 'main_risks',
      section: 'risks',
      order: 20,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 4000,
      },
      texts: {
        'ru-RU': {
          label: 'Главные риски и что может сломать план',
          help_md:
            'Три-пять рисков: рыночные, продуктовые, командные, регуляторные, зависимость от партнёров. По каждому — что делаете, чтобы снизить.',
          example_good_md:
            'Приход Авто.ру с бесплатной записью — снижаем через учёт постов и интеграции, которых у них нет. Уход CTO — код документирован, есть второй разработчик. Единственный SMS-провайдер — подключён запасной',
          example_weak_md: 'Основной риск — недостаток финансирования',
        },
      },
    },
    {
      key: 'legal_entity',
      section: 'legal',
      order: 10,
      type: 'select',
      options: [
        {
          code: 'none',
          texts: {
            'ru-RU': {
              label: 'Нет',
            },
          },
        },
        {
          code: 'in_progress',
          texts: {
            'ru-RU': {
              label: 'Регистрируется',
            },
          },
        },
        {
          code: 'sole_proprietor',
          texts: {
            'ru-RU': {
              label: 'ИП',
            },
          },
        },
        {
          code: 'llc',
          texts: {
            'ru-RU': {
              label: 'ООО',
            },
          },
        },
        {
          code: 'jsc',
          texts: {
            'ru-RU': {
              label: 'АО',
            },
          },
        },
        {
          code: 'foreign',
          texts: {
            'ru-RU': {
              label: 'Иностранная компания',
            },
          },
        },
      ],
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'public',
      texts: {
        'ru-RU': {
          label: 'Есть ли юридическое лицо?',
          help_md: 'То, через которое будет сделка. Если несколько — основное.',
        },
      },
    },
    {
      key: 'jurisdiction',
      section: 'legal',
      order: 20,
      type: 'text',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 200,
      },
      texts: {
        'ru-RU': {
          label: 'Где зарегистрировано?',
          help_md:
            'Страна и город; для иностранной компании — юрисдикция и есть ли российское лицо.',
        },
      },
    },
    {
      key: 'ip_rights',
      section: 'legal',
      order: 30,
      type: 'textarea',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Кому принадлежат права на продукт?',
          help_md:
            'Код, бренд, патенты, данные: оформлены на компанию, на основателя лично, на подрядчика или не оформлены. Приложите свидетельство или патент, если есть.',
          example_good_md:
            'Код — на ООО по договорам с разработчиками; товарный знак подан 05.2026 (приложено); патента нет',
          example_weak_md: 'Всё наше',
        },
      },
    },
    {
      key: 'licenses_regulatory',
      section: 'legal',
      order: 40,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      evidence: true,
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Лицензии, разрешения, регуляторные требования',
          help_md:
            'Что требуется, чтобы продавать продукт легально, что уже получено, что в процессе, сроки и стоимость. Для медицины и биотеха — регуляторный путь целиком: класс изделия, испытания, регистрация, где вы сейчас.',
          example_good_md:
            'Медизделие класса 2а; технические испытания завершены 07.2026 (протокол приложен), клинические запланированы на Q1 2027, регистрация Росздравнадзора — ожидаемо Q4 2027, бюджет 6 млн ₽',
          example_weak_md: 'Лицензии не требуются» (без пояснения, почему).',
        },
      },
    },
    {
      key: 'ownership',
      section: 'legal',
      order: 50,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'private',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Распределение долей',
          help_md:
            'Доли основателей, инвесторов, опционный пул; кто ещё имеет права на компанию. Видно только платформе и вам; инвестору — по запросу.',
          example_good_md:
            'Петров 55%, Сидорова 35%, опционный пул 10% (не выдан); внешних инвесторов нет',
          example_weak_md: 'Доли распределены между основателями',
        },
      },
    },
    {
      key: 'pitch_deck',
      section: 'materials',
      order: 10,
      type: 'material_ref',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxItems: 1,
      },
      texts: {
        'ru-RU': {
          label: 'Презентация (pitch deck)',
          help_md:
            'Если есть. Заявка не требует презентации: всё существенное инвестор увидит в карточке.',
        },
      },
    },
    {
      key: 'other_materials',
      section: 'materials',
      order: 20,
      type: 'material_ref',
      stages: {
        idea: 'recommended',
        mvp: 'recommended',
        early_revenue: 'recommended',
        growth: 'recommended',
      },
      visibility: 'investors',
      constraints: {
        maxItems: 20,
      },
      texts: {
        'ru-RU': {
          label: 'Другие материалы',
          help_md:
            'Исследования, отчёты, письма, публикации — то, что не приложено к конкретному ответу. Можно несколько.',
        },
      },
    },
    {
      key: 'data_room_readiness',
      section: 'materials',
      order: 30,
      type: 'textarea',
      stages: {
        idea: 'hidden',
        mvp: 'hidden',
        early_revenue: 'hidden',
        growth: 'hidden',
      },
      visibility: 'investors',
      constraints: {
        maxLength: 2000,
      },
      texts: {
        'ru-RU': {
          label: 'Какие документы готовы предоставить при углублённой проверке?',
          help_md:
            'Перечислите: устав и реестр участников, договоры с ключевыми клиентами и партнёрами, финансовая отчётность, трудовые договоры и права на код. Не загружайте их сюда — только список и статус.',
          example_good_md:
            'Готовы: устав, отчётность за 2025–2026, договоры с 11 клиентами, договоры с разработчиками с передачей прав. Нет: акционерное соглашение',
          example_weak_md: 'Всё есть, предоставим по запросу',
        },
      },
    },
  ],
};
