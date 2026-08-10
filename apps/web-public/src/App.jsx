import React, { useState } from 'react'

const Icon = ({ name, size = 18, fill = 'none' }) => {
  const paths = {
    arrow: <><path d='M5 12h14'/><path d='m13 6 6 6-6 6'/></>,
    bookmark: <path d='M6 4h12v16l-6-4-6 4z'/>,
    chevron: <path d='m7 10 5 5 5-5'/>,
    globe: <><circle cx='12' cy='12' r='9'/><path d='M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'/></>,
    grid: <><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/></>,
    menu: <><path d='M4 7h16M4 12h16M4 17h16'/></>,
    play: <path d='m9 7 8 5-8 5z'/>,
    rocket: <><path d='M14 4c3-1 5-1 6 0 0 1 0 3-1 6l-6 6-5-5 6-7z'/><path d='m8 11-4 1-2 3 5 1M13 16l-1 4-3 2-1-5'/></>,
    search: <><circle cx='11' cy='11' r='7'/><path d='m20 20-4-4'/></>,
    shield: <><path d='M12 3 4 6v6c0 5 3 8 8 10 5-2 8-5 8-10V6l-8-3z'/><path d='m9 12 2 2 4-5'/></>,
    sliders: <><path d='M4 6h16M4 12h16M4 18h16'/><circle cx='9' cy='6' r='2'/><circle cx='15' cy='12' r='2'/><circle cx='7' cy='18' r='2'/></>,
    sparkles: <><path d='m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z'/><path d='m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z'/></>,
    users: <><circle cx='9' cy='8' r='3'/><circle cx='17' cy='9' r='2.5'/><path d='M3 20c0-4 2-6 6-6s6 2 6 6M14 15c4 0 7 1 7 5'/></>,
    close: <><path d='m6 6 12 12M18 6 6 18'/></>,
    heart: <path d='M20 8c0 6-8 11-8 11S4 14 4 8c0-4 5-5 8-1 3-4 8-3 8 1z'/>,
  }

  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill={fill} stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
      {paths[name]}
    </svg>
  )
}

const projects = [
  { title:'NeuroMind AI', text:'AI-платформа для анализа данных и выявления паттернов', price:'$1.2M', tag:'AI', status:'Ищет инвестора', tone:'green', image:'/assets/proj1.jpg' },
  { title:'CourseAI', text:'Платформа для создания и продажи онлайн-курсов', price:'$750K', tag:'SaaS', status:'Ищет партнёра', tone:'purple', image:'/assets/proj2.jpg' },
  { title:'DesignHub', text:'Маркетплейс дизайнерской мебели и декора', price:'$2.3M', tag:'Marketplace', status:'Доступен к покупке', tone:'blue', image:'/assets/proj3.jpg' },
  { title:'PayFlow', text:'Сервис для бизнеса по приёму платежей', price:'$1.8M', tag:'FinTech', status:'Ищет инвестора', tone:'green', image:'/assets/proj4.jpg' },
  { title:'AI Assistant', text:'Конструктор AI-ассистентов для бизнеса', price:'$900K', tag:'AI', status:'Ищет команду', tone:'orange', image:'/assets/proj5.jpg' },
  { title:'StageFlow', text:'Платформа для презентации стартапов и поиска партнёров', price:'Seed', tag:'Venture', status:'Открыт к диалогу', tone:'purple', image:'/assets/hero.jpg' },
]

const shorts = [
  { title:'Онлайн-обучение сотрудников', author:'EduFlow', time:'0:42', image:'/assets/short1.jpg' },
  { title:'AI-помощник для анализа документов', author:'DocAI', time:'0:35', image:'/assets/short2.jpg' },
  { title:'Маркетплейс услуг для бизнеса', author:'BizHub', time:'0:41', image:'/assets/short3.jpg' },
  { title:'Сервис доставки здоровой еды', author:'EatWell', time:'0:36', image:'/assets/short4.jpg' },
  { title:'Инструмент аналитики продаж', author:'SalesVision', time:'0:48', image:'/assets/short5.jpg' },
  { title:'Фитнес-тренер для тренировок', author:'MoneyTrack', time:'0:36', image:'/assets/short6.jpg' },
]

const categories = ['AI и автоматизация','SaaS и сервисы','Маркетплейсы','Мобильные приложения','Онлайн-образование','FinTech','HealthTech','Web3','Игры','Все направления']

function App() {
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [modal, setModal] = useState(null)

  return <>
    <header className='header container'>
      <a className='brand' href='#top'><span className='brand-mark'>⚡</span><span>LaunchBridge</span></a>
      <nav className={mobileOpen ? 'nav open' : 'nav'}>
        <a href='#projects'>Проекты</a><a href='#investors'>Инвесторы</a><a href='#shorts'>Shorts</a><a href='#categories'>Категории</a><a href='#developers'>Для разработчиков</a><a href='#about'>О нас</a>
      </nav>
      <div className='header-actions'>
        <button className='lang'><Icon name='globe' size={16}/> RU <Icon name='chevron' size={14}/></button>
        <button className='btn ghost' onClick={() => setModal('login')}>Войти</button>
        <button className='btn primary small' onClick={() => setModal('signup')}>Регистрация</button>
        <button className='menu-btn' onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <Icon name='close'/> : <Icon name='menu'/>}</button>
      </div>
    </header>


    <main id='top'>
      <section className='hero container'>
        <div className='hero-copy'>
          <div className='eyebrow'><Icon name='sparkles' size={14}/> Платформа для основателей, команд и инвесторов</div>
          <h1 className='hero-title'>Превратите идею<br/>в технологический бизнес.</h1>
          <p className='hero-description'>От идеи до команды, инвестиций и запуска —<br className='desktop'/> всё необходимое на одной платформе.</p>
          <div className='hero-buttons'>
            <button className='btn primary' onClick={() => setModal('signup')}>Разместить проект <Icon name='rocket' size={17}/></button>
            <button className='btn ghost'>Я инвестор <Icon name='arrow' size={17}/></button>
          </div>
          <div className='stats'>
            <div><b>3 245+</b><span>проектов</span></div>
            <div><b>1 870+</b><span>инвесторов</span></div>
            <div><b>$320M+</b><span>привлечено инвестиций</span></div>
            <div><b>42</b><span>страны</span></div>
          </div>
        </div>

        <div className='show-card stage-card'>
          <img className='stage-visual' src='/assets/rocket-laptop.png' alt='Ноутбук и ракета LaunchBridge'/>
          <div className='stage-vignette'></div>
          <div className='stage-brand'>LAUNCHBRIDGE SHOW</div>
          <div className='stage-screen-copy' aria-label='Рекламные сообщения LaunchBridge'>
            <span>Измени своё будущее сейчас</span>
            <span>Покажи проект миллионам по всему миру</span>
            <span>Твоя сцена ждёт тебя</span>
          </div>
          <button className='stage-action' onClick={() => setModal('signup')}>
            <Icon name='rocket' size={17}/> Выйти на сцену
          </button>
        </div>
      </section>

      <section className='search-row container' id='categories'>
        <label className='searchbox'><Icon name='search' size={20}/><input placeholder='Поиск проектов, команд, технологий...'/></label>
        <button className='filter'><Icon name='sliders' size={18}/> Фильтры</button>
        <button className='categories-btn' onClick={() => setCategoriesOpen(!categoriesOpen)}><Icon name='grid'/><span><b>Все категории</b><small>Откройте все направления проектов</small></span><Icon name='chevron'/></button>
        {categoriesOpen && <div className='categories-popover'>{categories.map(category => <button key={category}>{category}<Icon name='arrow' size={14}/></button>)}</div>}
      </section>

      <section className='catalog container'>
        <div className='catalog-section' id='projects'>
          <div className='section-head'><div><span>ПОДБОРКА ПЛАТФОРМЫ</span><h3>Популярные проекты</h3></div><a href='#'>Смотреть все <Icon name='arrow' size={15}/></a></div>
          <div className='cards-grid'>
            {projects.map(project => (
              <article className='project-card' key={project.title}>
                <div className='project-image'><img src={project.image} alt=''/><span className='tag'>{project.tag}</span><button><Icon name='bookmark' size={17}/></button></div>
                <div className='project-body'><h4>{project.title}</h4><p>{project.text}</p><div className='project-meta'><strong>{project.price}</strong><span className={`status ${project.tone}`}>{project.status}</span></div></div>
              </article>
            ))}
          </div>
        </div>

        <div className='catalog-section' id='shorts'>
          <div className='section-head'><div><span>ИДЕИ ЗА ОДНУ МИНУТУ</span><h3>Shorts</h3></div><a href='#'>Смотреть все <Icon name='arrow' size={15}/></a></div>
          <div className='cards-grid'>
            {shorts.map(short => (
              <article className='short-card' key={short.title} style={{ backgroundImage:`url(${short.image})` }}>
                <div className='short-shade'></div><span className='time'>{short.time}</span><button className='bookmark'><Icon name='bookmark' size={16}/></button><button className='short-play'><Icon name='play' size={17} fill='currentColor'/></button><div className='short-copy'><b>{short.title}</b><small>{short.author}</small></div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className='benefits container' id='about'>
        <div><Icon name='rocket'/><b>Привлекайте инвестиции</b><p>Находите инвесторов и получайте финансирование.</p></div>
        <div><Icon name='users'/><b>Публикуйте и развивайтесь</b><p>Делитесь проектом и получайте обратную связь.</p></div>
        <div><Icon name='sparkles'/><b>Новые возможности</b><p>Находите партнёров, клиентов и новые рынки.</p></div>
        <div><Icon name='shield'/><b>Безопасные сделки</b><p>Проверка проектов и защита участников.</p></div>
        <div><Icon name='globe'/><b>Международное сообщество</b><p>Тысячи разработчиков и инвесторов.</p></div>
        <div><Icon name='heart'/><b>Поддержка и сервисы</b><p>Эксперты и инструменты для развития.</p></div>
      </section>

      <section className='final-cta container'>
        <div className='final-cta__content'>
          <span className='final-cta__label'>Следующий шаг начинается здесь</span>
          <h2>Готовы вывести проект<br/>на новый уровень?</h2>
          <p>Присоединяйтесь к LaunchBridge и станьте частью международного сообщества инноваций.</p>
          <div className='final-cta__actions'>
            <button className='btn primary' onClick={() => setModal('signup')}>Разместить проект</button>
            <button className='btn final-cta__secondary' onClick={() => setModal('login')}>Стать инвестором</button>
          </div>
        </div>
        <div className='final-cta__planet' aria-hidden='true'><i></i><i></i><i></i></div>
      </section>
    </main>

    {modal && <div className='modal' onClick={() => setModal(null)}>
      <div className='modal-box' onClick={event => event.stopPropagation()}>
        <button className='modal-close' onClick={() => setModal(null)}>
          <Icon name='close'/>
        </button>
        <h3>{modal === 'login' ? 'Вход в LaunchBridge' : 'Создать аккаунт'}</h3>
        <input placeholder='Email'/>
        <input placeholder='Пароль' type='password'/>
        <button className='btn primary'>{modal === 'login' ? 'Войти' : 'Зарегистрироваться'}
          </button><small>Демонстрационная форма для презентации.</small>
          </div>
      </div>
    }
  </>
}

export default App
