"""Детерминированный анализ проекта — baseline модели `ai_score` v0.1-heuristic.

Это НЕ имитация LLM. Это воспроизводимый расчёт по наблюдаемым признакам
заявки: что именно повлияло на оценку, видно в `explanation` каждой оси, и один
и тот же вход всегда даёт один и тот же выход.

Смысл baseline'а — не «что-нибудь показать до подключения модели», а точка
отсчёта: будущая модель обязана показать улучшение относительно него на
эталонном наборе, иначе подключать её незачем (`RULES.md` §4).

Границы честности, которые здесь соблюдаются:
  * оценка описывает ПОЛНОТУ И КАЧЕСТВО ЗАЯВКИ, а не перспективы бизнеса;
  * ни одна ось не выдаёт число без объяснения, откуда оно;
  * там, где сигналов нет, оценка низкая с явным «сигналов не найдено», а не
    средняя «чтобы не обижать».
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Final

MODEL_VERSION: Final[str] = "v0.1-heuristic"

AXES: Final[tuple[str, ...]] = (
    "market",
    "demand",
    "competitive_edge",
    "uniqueness",
    "profitability",
    "presentation_quality",
    "scalability",
    "investment_readiness",
    "product_readiness",
)

AXIS_WEIGHTS: Final[dict[str, float]] = {
    "market": 0.15,
    "demand": 0.15,
    "competitive_edge": 0.10,
    "uniqueness": 0.10,
    "profitability": 0.10,
    "presentation_quality": 0.05,
    "scalability": 0.15,
    "investment_readiness": 0.10,
    "product_readiness": 0.10,
}

READINESS_DIMENSIONS: Final[tuple[str, ...]] = (
    "problem",
    "solution",
    "product",
    "tech",
    "team",
    "market",
    "competition",
    "business_model",
    "unit_economics",
    "legal",
    "finance",
    "pitch",
    "data_room",
)

# Лексика сигналов. Русские и английские формы — заявки приходят на обоих
# языках, и отсутствие английской формы означало бы заниженную оценку за язык.
SIGNALS: Final[dict[str, tuple[str, ...]]] = {
    "problem": ("проблем", "боль", "problem", "pain point"),
    "solution": ("решени", "solution", "подход", "approach"),
    "product": ("продукт", "product", "mvp", "прототип", "prototype", "релиз", "release"),
    "tech": ("технолог", "архитектур", "stack", "technology", "algorithm", "алгоритм"),
    "team": ("команд", "основател", "team", "founder", "cto", "опыт", "experience"),
    "market": ("рынок", "рынк", "market", "tam", "sam", "som", "сегмент", "segment"),
    "competition": ("конкурент", "competitor", "аналог", "alternative", "отличие"),
    "business_model": ("модель", "монетиз", "business model", "revenue", "подписк", "subscription"),
    "unit_economics": ("unit", "экономик", "ltv", "cac", "маржа", "margin", "retention"),
    "legal": ("юридич", "лиценз", "патент", "legal", "license", "patent", "ip", "товарный знак"),
    "finance": ("выручк", "revenue", "прибыл", "profit", "burn", "runway", "оборот"),
    "pitch": ("питч", "презентац", "pitch", "deck"),
    "traction": ("трэкшн", "traction", "пользовател", "users", "клиент", "customers", "mrr", "arr"),
    "scale": ("масштаб", "scale", "международ", "international", "b2b", "b2c", "платформ"),
    "uniqueness": ("уникальн", "патент", "ноу-хау", "unique", "proprietary", "запатент"),
}

# Зрелость стадии. Ключи ОБЯЗАНЫ покрывать `ProjectStageSchema` контрактов:
# idea, mvp, early_revenue, growth. Стадия, которой здесь нет, приводится строкой
# ниже к «idea» — то есть проект с первой выручкой считался как пустая идея, и
# именно на этой когорте (23 из 100 карточек каталога) baseline был смещён.
# `prototype` и `scale` в контракте отсутствуют: оставлены задельными значениями
# на случай расширения шкалы, порядок между ними и соседями сохранён.
STAGE_MATURITY: Final[dict[str, float]] = {
    "idea": 0.15,
    "prototype": 0.35,
    "mvp": 0.55,
    "early_revenue": 0.65,
    "growth": 0.75,
    "scale": 0.9,
}

# Ниже этой длины текст не несёт содержания, сколько бы ключевых слов в нём ни было.
MIN_MEANINGFUL_CHARS: Final[int] = 120
# Выше этой длины прирост оценки за объём прекращается: заявку не пишут длиной.
SATURATION_CHARS: Final[int] = 4000


@dataclass(frozen=True)
class Score:
    axis: str
    value: float
    confidence_low: float
    confidence_high: float
    explanation: str
    sources: list[str]


@dataclass(frozen=True)
class Fact:
    category: str
    key: str
    value: dict
    confidence: float
    source_type: str
    source_ref: str


def _normalize(text: str) -> str:
    """NFKC + нижний регистр.

    Без нормализации «ＭＲＲ» или «ＭVP» в полноширинных символах не совпадут с
    лексикой, и заявка получит заниженную оценку за форму записи.
    """
    return unicodedata.normalize("NFKC", text or "").lower()


def _hits(text: str, key: str) -> int:
    return sum(1 for token in SIGNALS[key] if token in text)


def _has_numbers(text: str) -> bool:
    """Есть ли в тексте количественные утверждения, а не только прилагательные."""
    return bool(re.search(r"\d[\d\s.,]*\s*(%|₽|руб|тыс|млн|млрд|k|m|x|раз)", text))


def _bounded(value: float) -> float:
    return max(0.0, min(100.0, round(value, 2)))


def _confidence_band(value: float, evidence: int) -> tuple[float, float]:
    """Чем меньше подтверждающих сигналов, тем шире интервал.

    Узкий интервал при одном найденном слове был бы ложной точностью — худшей
    ошибкой, чем низкая оценка.
    """
    width = 25.0 if evidence == 0 else max(6.0, 22.0 - 4.0 * min(evidence, 4))
    return _bounded(value - width), _bounded(value + width)


def _volume_factor(length: int) -> float:
    if length < MIN_MEANINGFUL_CHARS:
        return 0.0
    span = SATURATION_CHARS - MIN_MEANINGFUL_CHARS
    return min(1.0, (length - MIN_MEANINGFUL_CHARS) / span)


def _axis_score(
    axis: str,
    *,
    base: float,
    evidence: int,
    quantified: bool,
    volume: float,
    notes: list[str],
) -> Score:
    value = base * 100.0
    if quantified:
        value += 8.0
        notes.append("есть количественные утверждения")
    value += 10.0 * volume
    value = _bounded(value)
    low, high = _confidence_band(value, evidence)
    explanation = (
        f"Эвристика {MODEL_VERSION}: "
        + ("; ".join(notes) if notes else "подтверждающих сигналов в заявке не найдено")
        + ". Оценка описывает полноту и проверяемость заявки, а не перспективы бизнеса."
    )
    return Score(
        axis=axis,
        value=value,
        confidence_low=low,
        confidence_high=high,
        explanation=explanation,
        sources=["application_text", "materials"],
    )


# Таблица полуинтервалов балла — та же, что в ядре (scoring-rules.ts). Здесь
# только для контрольного значения: публикуемый балл считает ядро.
_SCORE_TABLE: Final[tuple[tuple[float, int], ...]] = (
    (82, 10), (74, 9), (66, 8), (58, 7), (50, 6), (42, 5), (33, 4), (24, 3), (13, 2), (0, 1),
)


def _score10(irs: float) -> int:
    for lo, score in _SCORE_TABLE:
        if irs >= lo:
            return score
    return 1


def _irs_breakdown(scores: list) -> dict:
    breakdown: dict = {}
    for s in scores:
        breakdown[s.axis] = s.value
        breakdown[f"{s.axis}_w"] = round(s.value * AXIS_WEIGHTS[s.axis], 2)
    breakdown["sum"] = _bounded(sum(s.value * AXIS_WEIGHTS[s.axis] for s in scores))
    return breakdown


def analyze(project: dict) -> dict:
    """Полный разбор заявки. Чистая функция: один вход — один выход."""
    title = str(project.get("title") or "")
    summary = str(project.get("summary") or "")
    # Стадия попадает в тексты, публикуемые инвесторам. Экранирование —
    # обязанность фронтенда, но свободную строку из запроса дешевле свести к
    # известному перечислению прямо здесь (INFO внешнего аудита №2):
    # неизвестное значение становится 'idea' — тем же, что и пустое.
    stage_raw = str(project.get("stage") or "idea").lower()
    stage = stage_raw if stage_raw in STAGE_MATURITY else "idea"
    materials = project.get("materials") or []

    material_texts = [str(m.get("text") or "") for m in materials]
    corpus = _normalize("\n".join([title, summary, *material_texts]))
    length = len(corpus)
    volume = _volume_factor(length)
    quantified = _has_numbers(corpus)
    maturity = STAGE_MATURITY.get(stage, 0.15)

    material_kinds = {str(m.get("type") or "") for m in materials}
    has_deck = "deck" in material_kinds
    has_product = "product_link" in material_kinds

    def signal(key: str) -> int:
        return _hits(corpus, key)

    scores: list[Score] = []

    market_hits = signal("market")
    scores.append(
        _axis_score(
            "market",
            base=min(0.85, 0.15 + 0.18 * market_hits) * (0.6 + 0.4 * maturity),
            evidence=market_hits,
            quantified=quantified,
            volume=volume,
            notes=[f"упоминаний рынка: {market_hits}"] if market_hits else [],
        )
    )

    demand_hits = signal("traction") + signal("problem")
    scores.append(
        _axis_score(
            "demand",
            base=min(0.85, 0.12 + 0.14 * demand_hits) * (0.6 + 0.4 * maturity),
            evidence=demand_hits,
            quantified=quantified,
            volume=volume,
            notes=[f"сигналов спроса и проблемы: {demand_hits}"] if demand_hits else [],
        )
    )

    edge_hits = signal("competition") + signal("uniqueness")
    scores.append(
        _axis_score(
            "competitive_edge",
            base=min(0.8, 0.10 + 0.16 * edge_hits),
            evidence=edge_hits,
            quantified=quantified,
            volume=volume,
            notes=[f"сравнений с конкурентами: {edge_hits}"] if edge_hits else [],
        )
    )

    uniq_hits = signal("uniqueness") + signal("tech")
    scores.append(
        _axis_score(
            "uniqueness",
            base=min(0.8, 0.10 + 0.15 * uniq_hits),
            evidence=uniq_hits,
            quantified=quantified,
            volume=volume,
            notes=[f"признаков уникальности и технологии: {uniq_hits}"] if uniq_hits else [],
        )
    )

    profit_hits = signal("business_model") + signal("unit_economics") + signal("finance")
    scores.append(
        _axis_score(
            "profitability",
            base=min(0.85, 0.08 + 0.13 * profit_hits),
            evidence=profit_hits,
            quantified=quantified,
            volume=volume,
            notes=[f"сигналов модели и экономики: {profit_hits}"] if profit_hits else [],
        )
    )

    pitch_notes: list[str] = []
    presentation_base = 0.20 + 0.35 * volume
    if has_deck:
        presentation_base += 0.25
        pitch_notes.append("приложена презентация")
    if length >= MIN_MEANINGFUL_CHARS:
        pitch_notes.append(f"объём описания {length} символов")
    scores.append(
        _axis_score(
            "presentation_quality",
            base=min(0.9, presentation_base),
            evidence=(1 if has_deck else 0) + (1 if volume > 0.3 else 0),
            quantified=quantified,
            volume=volume,
            notes=pitch_notes,
        )
    )

    scale_hits = signal("scale")
    scores.append(
        _axis_score(
            "scalability",
            base=min(0.85, 0.12 + 0.15 * scale_hits) * (0.6 + 0.4 * maturity),
            evidence=scale_hits,
            quantified=quantified,
            volume=volume,
            notes=[f"признаков масштабируемости: {scale_hits}"] if scale_hits else [],
        )
    )

    ir_notes: list[str] = [f"стадия «{stage}»"]
    ir_hits = signal("legal") + signal("finance") + signal("team")
    if has_deck:
        ir_notes.append("есть презентация")
    scores.append(
        _axis_score(
            "investment_readiness",
            base=min(0.85, 0.10 * maturity * 3 + 0.10 * ir_hits),
            evidence=ir_hits + (1 if has_deck else 0),
            quantified=quantified,
            volume=volume,
            notes=ir_notes,
        )
    )

    pr_notes: list[str] = [f"стадия «{stage}»"]
    pr_hits = signal("product") + signal("tech")
    if has_product:
        pr_notes.append("указана ссылка на продукт")
    scores.append(
        _axis_score(
            "product_readiness",
            base=min(0.9, maturity * 0.7 + 0.08 * pr_hits + (0.1 if has_product else 0.0)),
            evidence=pr_hits + (1 if has_product else 0),
            quantified=quantified,
            volume=volume,
            notes=pr_notes,
        )
    )

    irs = _bounded(sum(s.value * AXIS_WEIGHTS[s.axis] for s in scores))

    readiness: list[dict] = []
    for dimension in READINESS_DIMENSIONS:
        key = {"data_room": "pitch", "solution": "solution"}.get(dimension, dimension)
        hits = signal(key) if key in SIGNALS else 0
        if dimension == "data_room":
            hits = (1 if has_deck else 0) + (1 if has_product else 0)
        level = "high" if hits >= 3 else "medium" if hits >= 1 else "low"
        recommendations: list[str] = []
        if level == "low":
            recommendations.append(
                f"Раздел «{dimension}» в заявке не раскрыт: добавьте конкретику и цифры."
            )
        elif level == "medium":
            recommendations.append(
                f"Раздел «{dimension}» упомянут, но без подтверждений — добавьте источники."
            )
        readiness.append(
            {"dimension": dimension, "level": level, "recommendations": recommendations}
        )

    roadmap = [
        {
            "title": f"Раскрыть раздел «{item['dimension']}»",
            "description": item["recommendations"][0],
            "dimension": item["dimension"],
            "priority": 1 if item["level"] == "low" else 2,
            "orderIndex": index,
        }
        for index, item in enumerate(
            [r for r in readiness if r["level"] != "high"][:8], start=1
        )
    ]

    facts: list[Fact] = [
        Fact(
            category="market",
            key="market_signal_count",
            value={"count": market_hits},
            confidence=0.9 if market_hits else 0.4,
            source_type="application_text",
            source_ref="title+summary+materials",
        ),
        Fact(
            category="traction",
            key="quantified_claims",
            value={"present": quantified},
            confidence=0.95,
            source_type="application_text",
            source_ref="regex:numeric_claims",
        ),
        Fact(
            category="team",
            key="team_signal_count",
            value={"count": signal("team")},
            confidence=0.8 if signal("team") else 0.4,
            source_type="application_text",
            source_ref="title+summary+materials",
        ),
        Fact(
            category="tech",
            key="materials",
            value={"kinds": sorted(material_kinds), "count": len(materials)},
            confidence=1.0,
            source_type="materials",
            source_ref="project_materials_count",
        ),
    ]

    # Паспорт в той же строгой форме, что возвращает LLM (PassportSchema в
    # контрактах): одна схема на оба провайдера, иначе `.strict()` пришлось бы
    # ослаблять ради эвристики — и проверка перестала бы быть проверкой.
    # Балл и разбор IRS здесь — контрольные: ядро пересчитывает их само.
    high = [r["dimension"] for r in readiness if r["level"] == "high"]
    low = [r["dimension"] for r in readiness if r["level"] == "low"]
    # Эвристика не умеет отличать подтверждённое от заявленного: всё, что она
    # видит, — наличие чисел. Поэтому выше «claimed» она не поднимается никогда.
    evidence = "claimed" if length >= MIN_MEANINGFUL_CHARS and _has_numbers(corpus) else "absent"
    passport = {
        "score10": _score10(irs),
        "irsBreakdown": _irs_breakdown(scores),
        "scoreBasis": "disclosure",
        "verdict": (
            f"Разбор заявки эвристикой {MODEL_VERSION}: длина корпуса {length} симв., "
            f"материалов {len(materials)}, стадия «{stage}». Оценка описывает полноту "
            f"и проверяемость заявки, а не перспективы бизнеса."
        ),
        "strengths": [f"раскрыто: {d}" for d in high[:5]],
        "weaknesses": [f"не раскрыто: {d}" for d in low[:5]],
        "risks": [],
        "capsApplied": [],
        "penaltiesApplied": [],
        "integrityFlags": [],
        "complianceFlags": [],
        "businessModel": "not_stated",
        "askSanity": "not_stated",
        "investorExit": "not_stated",
        "evidenceLevel": evidence,
    }

    return {
        "modelVersion": MODEL_VERSION,
        "passport": passport,
        "facts": [
            {
                "category": f.category,
                "key": f.key,
                "value": f.value,
                "confidence": f.confidence,
                "sourceType": f.source_type,
                "sourceRef": f.source_ref,
            }
            for f in facts
        ],
        "scores": [
            {
                "axis": s.axis,
                "value": s.value,
                "confidenceLow": s.confidence_low,
                "confidenceHigh": s.confidence_high,
                "explanation": s.explanation,
                "sources": s.sources,
            }
            for s in scores
        ],
        "irs": {"value": irs},
        "readiness": readiness,
        "roadmap": roadmap,
    }
