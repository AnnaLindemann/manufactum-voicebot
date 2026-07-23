# Отчёт о реализации: локальные embeddings для staged FAQ chunks на Render

## Фаза

Реализована утверждённая test phase RAG: локальная генерация passage-эмбеддингов для уже
застейдженных FAQ chunks внутри существующего Node.js backend через Transformers.js. Внешние embedding
API, Hugging Face Endpoints, API-ключи и платные провайдеры не добавлялись.

Вне scope остались retrieval, cosine search, `/api/rag/query`, Dialfire, HNSW, crawler, scheduler,
коммиты и push.

## Изменённые файлы

- `.env.example` — добавлены только безопасные runtime toggles для cache/local-files-only; модель
  зафиксирована в кодовом profile, не через env.
- `package.json`, `package-lock.json` — добавлен `@xenova/transformers@2.17.2` и opt-in scripts.
- `migrations/0004_rag_embedding_profile_384.sql` — forward-only переход на профиль 384 измерения с
  fail-fast защитой от уже сохранённых immutable embeddings.
- `src/rag/embedding-profile.ts` — единый typed embedding profile.
- `src/rag/e5-passage-embeddings.ts` — ленивый локальный adapter Transformers.js.
- `src/rag/embed-staged-version.ts` — orchestration: embed missing staged chunks, then activate.
- `scripts/embed-staged-faq-chunks.ts` — opt-in CLI для PostgreSQL staged document.
- `scripts/smoke-rag-embedding-runtime.ts` — opt-in real runtime smoke test.
- `src/rag/document-store.ts`, `src/rag/in-memory-document-store.ts`,
  `src/rag/postgres-document-store.ts` — storage contract и реализации сохраняют полный profile
  metadata.
- `tests/unit/rag-e5-passage-embeddings.test.ts`,
  `tests/unit/rag-embed-staged-version.test.ts`,
  `tests/unit/rag-in-memory-document-store.test.ts`,
  `tests/unit/rag-ingest-faq-page.test.ts`,
  `tests/integration/rag-postgres-document-store.test.ts` — focused unit tests и opt-in integration
  coverage для нового profile.
- `docs/rag-embeddings-and-retrieval-design.md`, `docs/project-decisions.md` — зафиксировано решение
  local Transformers.js on Render, small/384.

## Pinned runtime facts

- Provider: `local-transformers-js`.
- Runtime package: `@xenova/transformers@2.17.2`.
- Model ID: `Xenova/multilingual-e5-small`.
- Immutable revision: `ae61bf0193ce3851dc8a45147e459b04ed783d8a`.
- ONNX artifact: `onnx/model_quantized.onnx`.
- Artifact SHA-256: `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193`.
- Remote artifact size: 118 MB.
- Dtype/quantization: `int8-quantized`, loader options `quantized: true`,
  `model_file_name: "model"`.
- Dimension: 384.
- Passage prefix: `passage: `.
- Tokenizer limit: 512 tokens.

`modelRevision` передаётся в `AutoTokenizer.from_pretrained(...)` и `pipeline("feature-extraction",
...)` как loader option `revision`, поэтому pinned revision используется фактическим loader, а не
только сохраняется как metadata.

## Функциональность

- Модель и tokenizer загружаются лениво; `/health` не импортирует и не загружает `@xenova/transformers`.
- Параллельные первые вызовы используют один shared in-flight loader.
- Перед токенизацией добавляется `passage: `.
- Truncation выполняется tokenizer-based после prefix: `truncation: true`, `max_length: 512`.
- Extractor вызывается с `pooling: "mean"` и `normalize: true`.
- Adapter принимает только 384-мерный L2-normalized vector.
- Ошибки структурированы и не включают FAQ text, tokens или secrets.
- Staged flow сохраняет только отсутствующие embeddings и безопасно продолжает прерванный запуск.
- Активация версии выполняется только через существующий gate полного покрытия.

## Миграционная защита

Новая миграция не переписывает старые миграции. Перед изменением `vector` на `vector(384)` она проверяет
`rag_chunk_embeddings`; если там есть строки, миграция завершается понятной ошибкой и ничего не удаляет,
не обрезает, не конвертирует и не смешивает.

Если строк embeddings нет, миграция добавляет profile metadata columns, меняет тип embedding column на
`vector(384)`, добавляет `CHECK (embedding_dim = 384)` и расширяет primary key до полного profile
identity.

## Проверки

Финальные результаты команд фиксируются в ответе Codex по завершении задачи. Реальный smoke test не
входит в обычный `npm test` и запускается вручную:

```sh
npm run rag:smoke-embedding
```

## Ограничения

- Render Free может засыпать; после spin-down возможны повторный download/reload модели и холодная
  latency.
- Реальный peak RAM и latency зависят от выбранного Render instance и измеряются только opt-in smoke
  test на целевой среде.
- PostgreSQL integration tests остаются opt-in через `RAG_TEST_DATABASE_URL`.
- Retrieval/query embeddings/no-answer threshold не реализованы в этой фазе.

## Следующий шаг

После принятия этой фазы: запустить opt-in smoke на Render/disposable environment, зафиксировать
фактические latency/RAM для Free instance, затем отдельно переходить к exact retrieval phase.
