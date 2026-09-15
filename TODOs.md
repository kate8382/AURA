TODO: remaining AURA improvements

Priority backlog (to address in follow-up iterations):

1) Add `decision` vs `confidence` fields and policy mapping
   - Schema: extend `per-case-schema.json` with `decision` or `recommended_action` (enum: allow/review/block)
   - Update: `recalc_confidence.ts` to optionally compute `decision` using thresholds and cross_check requirements.
   - Rationale: separate severity/policy from model confidence.

2) Machine-readable `cross_check` requirements
   - Add `requirements` field to `cross_check` items (e.g., `{type:'evidence', key:'authorization'}`)
   - Implement enforcement adapter interface to convert requirements into gate checks.

3) Use `scenarios[].text` for trigger extraction
   - Add optional lightweight NLP heuristics
   - Update generator to extract triggers from text when `triggers` missing

4) Improve trigger weighting strategy (TF-IDF or log-scaling)
   - Experiment with `topWeight`, `maxBoost`, and non-linear scaling

5) Add example CLI/SDK and an `examples/` folder with an end-to-end demo
   - Include a sample script demonstrating loadTriggerConfig + recalc on a single case

6) License/partnership docs
   - Add explicit guidance for commercial licensing and potential dual-licensing paths

7) Add auto-merge policy for bot PRs (optional)
   - If desired, implement auto-merge when PR passes CI and is green

8) Data cleanup sweep
   - Review all `public_cases/*` for category consistency and optional `signal_ids` additions

Notes:
- Prioritize items 1-3 after current sprint. Items 4-8 are medium-term.


### 1) decision vs confidence (policy mapping)

**- Зачем:** отделяет техническую оценку риска (confidence) от операционного вывода (decision: allow/review/block). Это нужно, если система будет автоматически принимать/блокировать запросы или отдавать результат в разные пайплайны.
**- Что даёт:** явные правила для действий, проще аудит и интеграция с политиками, меньше «магии» в UI/интеграциях.
Сложность: низкая→средняя. Нужно добавить поле в схему, простую пороговую логику в recalc_confidence.ts, и тесты. Возможно — конфигируемые пороги.
**- Подходит ли нам:** да, если планируете интеграцию с автоматическими блокировками/сервисами; если AURA — только библиотека для анализа, не обязателен, но полезен.

**Рекомендация:** сделать как опцию/флаг в recalc_confidence (низкий риск).

### 2) Machine‑readable cross_check requirements

**- Зачем:** формализовать требования (напр. «требуется авторизация/документ») чтобы downstream или UI мог автоматически запрашивать доказательства.
**- Что даёт:** позволяет строить автоматические workflow «требуется доказательство → запросить документ → перерасчёт», упрощает интеграцию с интерфейсом оператора.
**- Сложность:** средняя→высокая (проектирование формата, адаптеры, возможно интеграции внешних проверок).
**- Подходит ли нам:** да, если хотите делать более автоматизированные cross‑checks; если проект остаётся исследовательским, можно отложить.

**Рекомендация:** сделать RFC/схему сначала (легко), реализацию позже.

### 3) Извлечение триггеров из scenarios[].text (NLP heuristics)

**- Зачем:** многие кейсы могут не иметь вручную помеченных triggers. Автоизвлечение повышает покрытие и поддерживает масштаб.
**- Что даёт:** меньше ручной разметки, лучше покрытие сигналов, более стабильные веса.
**- Сложность:** низкая→средняя (начать с простых регулярок/ключевых фраз); более точное NLP (TF-IDF/embeddings) — дороже.
**- Подходит ли нам:** да. Начните с простых эвристик — быстрый выигрыш.

**Рекомендация:** добавить опциональный модуль извлечения (флаг в генераторе).

### 4) Улучшить стратегию взвешивания (TF‑IDF / лог‑шкала)

**- Зачем:** линейное масштабирование по частоте не всегда отражает информативность триггера; TF‑IDF уменьшает вес распространённых «шумных» триггеров.
**- Что даёт:** более адекватные веса, особенно при росте корпуса и если одни триггеры слишком частые.
**- Сложность:** средняя; нужно экспериментально подобрать параметры и оценить эффект.
**- Подходит ли нам:** полезно в долгосрочной перспективе; пока можно оставить текущее простое решение и сделать экспериментальную опцию.

**Рекомендация:** добавить как экспериментальный режим (--strategy=tfidf).

### 5) examples/ и CLI/SDK demo

**- Зачем:** показывает, как использовать AURA end‑to‑end — важно для внешних пользователей и внедрения.
**- Что даёт:** уменьшает порог вхождения, улучшает onboarding, облегчает тестирование.
**- Сложность:** низкая.
**- Подходит ли нам:** да — рекомендую.

**Рекомендация:** быстрое examples/simple-recalc.md + небольшой скрипт.

### 6) License/partnership docs

**- Зачем:** юридическая ясность при коммерческом использовании.
**- Что даёт:** предотвращает недоразумения и ускоряет коммерческие договорённости.
**- Сложность:** низкая (документирование и объяснения).
**- Подходит ли нам:** да, но вы уже частично это сделали в README — можно отложить.

### 7) Auto‑merge policy for bot PRs

**- Зачем:** автоматизировать мелкие обновления (генерация конфигов) без лишних ревью.
**- Что даёт:** меньше ручной работы, но риск автоматического мёрджа проблемных изменений.
**- Сложность:** низкая.
**- Подходит ли нам:** полезно при зрелом CI + тестах; пока мы сделали безопасную проверку «создавать PR только при изменениях» — авто‑мердж можно добавить позже при доверии к CI.

**Рекомендация:** отложить до стабильной CI.

### 8) Data cleanup sweep (категории, signal_ids)

**- Зачем:** согласованность данных — критична для корректных весов и метрик.
**- Что даёт:** повышает качество конфигов, облегчает анализ.
**- Сложность:** средняя (частично автоматизируется, но нужна ручная проверка).
**- Подходит ли нам:** да, это практическая и нужная задача.

**Рекомендация:** сгенерировать PR/патч‑лист для ручного ревью (как вы и хотели).