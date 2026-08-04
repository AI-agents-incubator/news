# Image Generation API для Instagram-пайплайна — Обновление апрель 2026

> **Историческое исследование, не runtime contract (обновлено 2026-07-20).**
> Текущий application path определён в `cover-lab/README.md`: FAL FLUX Dev
> создаёт background, а Recraft V3 image-to-image был частично проверен для
> model-rendered typography после того, как Flux composition в r02 исказил
> кириллицу. r03 также не доказал точную читаемую кириллицу; ни один маршрут не
> является publish-ready. Цены, рейтинги и альтернативы ниже не являются usage
> accounting и не дают права на deploy или Instagram publication.

## Что изменилось с конца 2025 года

Ландшафт сервисов генерации изображений радикально обновился в период январь–апрель 2026. Ключевые тренды: (1) появились **единые модели генерации + редактирования** (Qwen Image 2.0, Seedream 5 Lite) — больше не нужно два разных эндпоинта для t2i и img2img; (2) цены рухнули вниз — GPT Image Mini теперь $0.005/image, FLUX.2 Klein — $0.014–0.015; (3) **Nano Banana 2** (Gemini 3.1 Flash Image) вышел 26 февраля 2026 и добавил нативный 4:5 с API. Happy Horse — это **видеогенератор** (Alibaba/Taotian), не изображения, и для данного пайплайна не подходит.

***

## Актуальная таблица сравнения (апрель 2026)

### Модели первого эшелона (img2img + style ref + 4:5)

| Сервис | Дата выхода | img2img | Style Reference | 4:5 нативно | Скорость | Цена/изобр | Neg. Prompt | Seed | Оценка |
|--------|-------------|---------|-----------------|-------------|----------|------------|-------------|------|--------|
| **Recraft V3** | окт. 2024 | ✅ | ✅ Style-ID API (постоянный стиль) | ✅ `1024×1280` | ~11–15 с | $0.04[^1] | ✅ | ❓ | ⭐⭐⭐⭐⭐ |
| **FLUX.2 Pro / Dev / Klein** | ноя. 2025 / янв. 2026 | ✅ до 8 ref-изображений | ✅ multi-ref | ✅ любой AR | <10 с / <2 с (Klein) | $0.014–0.055[^2][^1] | ❌ | ✅ | ⭐⭐⭐⭐⭐ |
| **Nano Banana 2** (Gemini 3.1 Flash Image) | 26 фев. 2026 | ✅ до 14 ref-изображений | ✅ контекстно | ✅ `aspect_ratio: "4:5"` | 1.2–3.5 с | $0.067 (1K) / $0.063 via Atlas[^3] | ❌ | ✅ | ⭐⭐⭐⭐⭐ |
| **Seedream 5 Lite** | 13 фев. 2026 | ✅ до 14 ref-изображений | ✅ brand consistency | ✅ any AR | 5–10 с | $0.035[^3] | ✅ | ✅ | ⭐⭐⭐⭐⭐ |
| **Qwen Image 2.0** | 10 фев. 2026 | ✅ (unified edit) | ✅ | ✅ кастомные размеры | быстро | $0.021–0.035[^1][^3] | ✅ | ✅ | ⭐⭐⭐⭐ |
| **Ideogram V3** | март 2025 | ✅ Remix | ✅ до 3 ref | ✅ | 10–20 с | $0.030–0.050[^4] | ✅ | ✅ | ⭐⭐⭐⭐ |
| **HiDream I1 / E1.1** | апр. 2025 / июль 2025 | ✅ img2img + inpaint | ⚠️ style modifiers | ✅ | 10–20 с | $0.050–0.052[^5][^1] | ✅ | ✅ | ⭐⭐⭐ |
| **Grok Imagine Pro** | март 2026 | ✅ | ⚠️ style modifiers | ✅ `aspect_ratio` | 5–15 с | $0.070[^2] | ❌ | ❌ | ⭐⭐ |
| **GPT Image 1.5** | конец 2025 | ✅ | ⚠️ image input | ✅ | 10–20 с | $0.034–0.133[^2] | ❌ | ❌ | ⭐⭐ |

### Исключённые / не подходящие

| Сервис | Причина исключения |
|--------|-------------------|
| **Happy Horse 1.0** | Видеогенератор (T2V / I2V) Alibaba/Taotian — НЕ стоп-кадр изображение[^6][^7] |
| **Adobe Firefly** | Enterprise-only API, минимум ~$1,000/мес[^8] |
| **Midjourney** | Нет публичного REST API в апреле 2026[^9] |
| **Google Imagen 4 generate** | Нет img2img, нет 4:5 в generate-моделях[^10] |

***

## Детальный разбор новых сервисов 2026 года

### Nano Banana 2 — Gemini 3.1 Flash Image (26 февраля 2026)

«Nano Banana 2» — неофициальное прозвище модели `gemini-3.1-flash-image-preview` от Google. Модель занимает 2-е место в LM Arena (ELO 1,235) и является первой Flash-моделью Google с поддержкой 4K-вывода и Image Search Grounding. Для пайплайна критически важно: поддерживает `aspect_ratio: "4:5"` нативно через параметр `ImageConfig`, принимает до 14 reference-изображений в одном запросе через `contents[]`, а генерация занимает 1.2–3.5 секунды.[^11][^12][^13][^14][^15]

**Ограничение**: нет «постоянного стиля» как у Recraft — референсы передаются при каждом вызове. Также нет встроенного negative prompt — исключения описываются в тексте промпта.[^14]

```python
from google import genai
from google.genai import types
from PIL import Image

client = genai.Client(api_key="YOUR_GEMINI_API_KEY")

response = client.models.generate_content(
    model="gemini-3.1-flash-image-preview",
    contents=[
        "Generate a background image with the same color palette, composition style, "
        "and mood as the references. No text, no logos. Cinematic quality.",
        Image.open("template_ref1.png"),
        Image.open("template_ref2.png"),
    ],
    config=types.GenerateContentConfig(
        response_modalities=["IMAGE"],
        image_config=types.ImageConfig(
            aspect_ratio="4:5",
            image_size="2K",        # 1024×1280 для Instagram 4:5
        ),
    )
)
```

**Стоимость**: официально $0.067/image (1K res), $0.101 (2K); через Atlas Cloud — $0.063.[^3][^16]

***

### Seedream 5 Lite — ByteDance (13 февраля 2026)

Seedream 5 Lite — это самая новая мультимодальная модель ByteDance с «визуальным мышлением» и встроенным веб-поиском. Уникальная особенность: **Example-Based Controllable Editing** — достаточно показать одну пару «до/после», и модель применяет ту же трансформацию к любому количеству изображений без дополнительного промп-инжиниринга. Принимает до 14 input-изображений (`image_urls`), поддерживает brand consistency через reference images, seed, batch up to 4.[^17][^18][^19]

**Доступ через Together.ai** (самый простой из OpenAI-совместимых):
```python
from together import Together

client = Together()
response = client.images.create(
    model="ByteDance-Seed/Seedream-5.0-lite",
    prompt="Background image in the same editorial style as the reference. "
           "No text, no people, cinematic lighting, clean composition.",
    width=1080,
    height=1350,   # 4:5 Instagram portrait
    steps=28,
    image_url="https://your-cdn.com/template_reference.png",
    n=1,
)
print(response.data.url)
```

**Стоимость**: $0.035/image (официально). 90 изображений/мес = **$3.15/мес**.[^20][^3]

***

### Qwen Image 2.0 — Alibaba (10 февраля 2026)

Qwen Image 2.0 — это 7B-модель с единым пайплайном генерации и редактирования. Главная сила — профессиональный typography и infographic rendering (релевантно если потребуется AI-текст в будущем). Для img2img: принимает reference images, поддерживает cross-domain compositing (например, вставить объект из одного стиля в другой). Доступ через fal.ai за $0.021/image (img2img endpoint). По состоянию на февраль 2026 модель была в invite-only beta на Alibaba Cloud, но уже доступна через прокси-агрегаторы.[^21][^22][^1][^23]

***

### FLUX.2 Klein 4B / 9B — Black Forest Labs (январь 2026)

FLUX.2 Klein — компактные модели (4B и 9B параметров) с **end-to-end inference около 1 секунды** на дистиллированных вариантах. Поддерживают полный набор: style transformation, semantic changes, object replacement, multi-reference composition, inpainting. Aspect ratio: от 21:9 до 9:21, включая 4:5. Цена: $0.014–0.015/image — самый дешёвый вариант с поддержкой img2img из первого эшелона. Seed control ✅.[^1][^2][^24][^25]

***

### Happy Horse 1.0 — НЕ подходит для пайплайна

Happy Horse (HappyHorse-1.0) — это 15B-параметровая **видеомодель** от Alibaba/Taotian, выпущенная в апреле 2026. Она занимает #1 на Artificial Analysis Video Arena, генерирует 1080p видео с синхронным аудио за ~10 секунд, поддерживает image-to-video (I2V) с сохранением reference-стиля. Для задачи генерации **статичных фоновых изображений** 1080×1350 — не применима.[^6][^26][^27]

***

## Обновлённый LM Arena рейтинг изображений (март 2026)

| Ранг | Модель | ELO | API-доступ | Ключевая сила |
|------|--------|-----|-----------|---------------|
| 1 | GPT Image 1.5 | 1,284[^11] | OpenAI API | Текст, prompt adherence |
| 2 | Gemini 3 Pro Image (Nano Banana Pro) | 1,268[^11] | Gemini API | Versatility |
| 3 | FLUX.2 Pro v1.1 | 1,265[^11] | BFL / fal.ai / Replicate | Photorealism |
| 4 | FLUX.2 Pro | 1,258[^11] | BFL / fal.ai | High fidelity |
| 5 | FLUX.2 Dev | 1,245[^11] | BFL / fal.ai | Developer value |
| 6 | Hunyuan Image 3.0 | 1,238[^11] | Official API | Asian language |
| 7 | Seedream 4.5 / 5 Lite | ~1,225[^11] | Together / fal.ai | Creative aesthetics |
| 8 | Gemini 3.1 Flash (Nano Banana 2) | 1,235[^12] | Gemini API | Speed + 4K |
| ~9 | Qwen Image 2.0 | top ELO[^21] | fal.ai / Atlas | Text rendering |

***

## Обновлённая таблица стоимости (апрель 2026)

| Модель | Цена/image | 30 изобр/мес | 60 изобр/мес | 90 изобр/мес |
|--------|-----------|-------------|-------------|-------------|
| FLUX.2 Klein 4B | $0.014[^2] | $0.42 | $0.84 | $1.26 |
| Qwen Image 2.0 (img2img) | $0.021[^1] | $0.63 | $1.26 | $1.89 |
| FLUX.2 Dev | $0.025[^1] | $0.75 | $1.50 | $2.25 |
| FLUX.2 Pro | $0.030[^1] | $0.90 | $1.80 | $2.70 |
| Seedream 5 Lite | $0.035[^3] | $1.05 | $2.10 | $3.15 |
| Recraft V3 (img2img) | $0.040[^1] | $1.20 | $2.40 | $3.60 |
| Seedream 4.5 | $0.040[^28] | $1.20 | $2.40 | $3.60 |
| Nano Banana 2 (1K res) | $0.067[^16] | $2.01 | $4.02 | $6.03 |
| HiDream I1 | $0.050[^5] | $1.50 | $3.00 | $4.50 |
| Ideogram V3 | $0.030[^4] | $0.90 | $1.80 | $2.70 |

***

## Исторические рекомендации (апрель 2026, не текущий runtime choice)

### Стратегия A: Максимальный контроль стиля → Recraft V3 (без изменений)

Recraft V3 остаётся единственным сервисом с **постоянным Style-ID** — один раз загружаете шаблоны, используете `style_id` бессрочно. Это архитектурно чисто для пайплайна: нет необходимости передавать reference-изображения при каждом вызове. $0.04/image — разумная цена, а нативный размер `1024×1280` покрывает 4:5 Instagram напрямую.[^29][^30]

### Стратегия B: Скорость + мультиреференс → Nano Banana 2

Если нужна максимальная скорость (1–3 с) или нативная мультиреференсная генерация (несколько шаблонов за один вызов), Gemini 3.1 Flash Image — лучший выбор. Подходит для пайплайна с LLM-промптингом: всё через единый Google API, хорошая интеграция с Gemini для генерации промптов из текста дайджеста. Минус — дороже ($0.063–0.067/image).[^15][^14]

### Стратегия C: Минимальная цена → FLUX.2 Klein или Seedream 5 Lite

FLUX.2 Klein 4B при $0.014/image — дешевле в 3–4 раза остальных при схожем качестве и генерации за ~1 секунду. Seedream 5 Lite ($0.035) добавляет example-based style transfer — уникальная функция «покажи пару до/после». Оба доступны через fal.ai или Together.ai.[^19][^2][^25]

### Итоговое решение для пайплайна (апрель 2026)

| Приоритет | Модель | Почему |
|-----------|--------|--------|
| **Исторический кандидат** | **Recraft V3** | Постоянный style_id; нативный 4:5; чистый API — но r03 не подтвердил точную кириллицу |
| **Резерв A** | **FLUX.2 Klein 4B** | В 3× дешевле, 10× быстрее; multi-ref style; $1.26/90 изобр[^25] |
| **Резерв B** | **Seedream 5 Lite** | Example-based style learning; OpenAI-совместимый API Through Together[^17] |
| **Эксперимент** | **Nano Banana 2** | Скорость 1–3 с; Gemini-экосистема если промпты тоже через Gemini[^14] |

Никаких изменений в части исключений: Happy Horse, Adobe Firefly, Midjourney, и Imagen 4 generate-варианты остаются за рамками рекомендаций по тем же причинам.[^9][^8][^10][^6]

---

## References

1. [AI Image Model Pricing - Compare Replicate & Fal.ai API ...](https://pricepertoken.com/image) - Compare pricing for AI image generation models. Find the cheapest API for Flux, Stable Diffusion, Id...

2. [Image Generation API Pricing - March 2026 | Awesome Agents](https://awesomeagents.ai/pricing/image-generation-pricing/) - Image Generation API Pricing - March 2026 · Cheapest per image: GPT Image 1 Mini at $0.005 (low qual...

3. [Seedream 5.0 Lite API Pricing Breakdown : r/Bard - Reddit](https://www.reddit.com/r/Bard/comments/1rdfp6l/seedream_50_lite_api_pricing_breakdown/) - Seedream 5.0 Lite API Pricing Breakdown ; Seedream 4.5, $0.040, $0.038 ; Nano Banana Pro, $0.139 - $...

4. [AI Image Generation Pricing Comparison (2026)](https://www.buildmvpfast.com/api-costs/ai-image) - Compare AI image generation API pricing for February 2026. GPT Image 1.5, Flux 2 Pro, Imagen 4, and ...

5. [HiDream I1 Full: Advanced Text-to-Image AI | fal](https://fal.ai/models/fal-ai/hidream-i1-full) - Transform ideas into reality with HiDream I1 Full, an open-source image generation model delivering ...

6. [HappyHorse AI Video Generator Review 2026: Is It Really the New ...](https://www.veo3ai.io/blog/happyhorse-ai-video-generator-review-2026) - It generates up to 1080p video with natively synchronized audio in a single inference pass from text...

7. [HappyHorse 1.0 AI Video Generator | Happy Horse AI Text-to-Video ...](https://happy-horse.ai) - HappyHorse AI (Happy Horse) is a top-ranked 2026 AI video model. Text-to-video & image-to-video with...

8. [Adobe Firefly API Pricing 2026: Credits & Cost Guide - SudoMock](https://sudomock.com/blog/adobe-firefly-api-pricing-2026) - Adobe Firefly API uses generative credits at $0.02-0.10/image. Full 2026 credit breakdown, enterpris...

9. [Is Midjourney free? What to know now (a 2026 update) - CometAPI](https://www.cometapi.com/is-midjourney-free-what-to-know-now-a-2026-update/) - As of early 2026, Midjourney does not offer an official developer API, REST endpoint, SDK, webhook i...

10. [Imagen 4 | Generative AI on Vertex AI - Google Cloud Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/imagen/4-0-generate) - Imagen 4 is our latest line of image generation models. This page documents the capabilities and fea...

11. [Complete Guide to AI Image Generation APIs in 2026 - WaveSpeed AI](https://wavespeed.ai/blog/posts/complete-guide-ai-image-apis-2026/) - Complete guide to AI image generation APIs in 2026 with LM Arena rankings. Compare GPT Image, Gemini...

12. [AI Image Generation 2026: GPT Image 1.5, Gem… - Till Freitag](https://till-freitag.com/blog/ai-image-generation-models-2026) - AI image generation has fundamentally changed in 2026: the top 9 models on LM Arena are separated by...

13. [Nano Banana 2 | AI Image Generator by Gemini 3.1 Flash - Lora AI](https://loraai.io/nano-banana-2)

14. [Nano Banana image generation - Google AI for Developers](https://ai.google.dev/gemini-api/docs/image-generation) - Check the Batch API image generation documentation and the cookbook for Batch API image examples and...

15. [What Image Aspect Ratios Does Nano Banana 2 Support? (16:9 to ...](https://www.glbgpt.com/hub/what-image-aspect-ratios-does-nano-banana-2-support/) - What image aspect ratios does Nano Banana 2 support? From 1:1 square to 21:9 ultra-wide, get the exa...

16. [Nano Banana 2 API Pricing Explained: Official vs Proxy Cost ...](https://blog.laozhang.ai/en/posts/nano-banana-2-api-pricing-guide) - Nano Banana 2 (Gemini 3.1 Flash Image) API pricing ranges from $0.045 to $0.151 per image depending ...

17. [Seedream 5.0 Lite API | Together AI](https://www.together.ai/models/seedream-50-lite) - Seedream 5.0 Lite is ByteDance's unified multimodal image generation model with built-in visual reas...

18. [How to Use Seedream 5.0 Lite API - EvoLink.AI](https://evolink.ai/blog/how-to-use-seedream-5-0-lite-api-2026) - A step-by-step guide to Seedream 5.0 Lite async integration, including submit-poll-save flow, reques...

19. [Seedream 5: Complete Guide to ByteDance's Next-Gen AI Image ...](https://createvision.ai/guides/seedream-5-complete-guide) - Based on the Seedream development cycle and industry signals, we anticipate a launch in 2026. Create...

20. [Seedream v5.0 Lite (T2I) API Image by BYTEDANCE - Atlas Cloud](https://www.atlascloud.ai/models/bytedance/seedream-v5.0-lite) - 1. Introduction. Seedream 5.0 Lite is an advanced multimodal image generation model developed by Byt...

21. [What Is Qwen Image 2.0? Architecture, Features & Benchmarks (2026)](https://wavespeed.ai/blog/posts/blog-what-is-qwen-image-2-0-features-benchmarks/) - Qwen Image 2.0 is Alibaba's next-gen image model with native 2K resolution, professional text render...

22. [Qwen-Image-2.0 is out - 7B unified gen+edit model with native 2K ...](https://www.reddit.com/r/LocalLLaMA/comments/1r0w7st/qwenimage20_is_out_7b_unified_genedit_model_with/) - Qwen team just released Qwen-Image-2.0. Before anyone asks - no open weights yet, it's API-only on A...

23. [Qwen-Image is a powerful image generation foundation ... - GitHub](https://github.com/QwenLM/Qwen-Image) - Qwen-Image is a powerful image generation foundation model capable of complex text rendering and pre...

24. [FLUX.2 [KLEIN]: The Essentials - Scenario](https://help.scenario.com/en/articles/flux-2-klein-the-essentials/) - Upload your first reference image, dial in your aspect ratio, and see your vision come to life. The ...

25. [FLUX.2 [klein] 4B & 9B - Fast local image editing and generation](https://blog.comfy.org/p/flux2-klein-4b-fast-local-image-editing) - A compact undistilled model with an exceptional quality-to-size ratio. Efficient local deployment. S...

26. [HappyHorse AI Review: Is It Worth It in 2026 - Magiclight.AI](https://magiclight.ai/academy/happyhorse-ai-review/) - What makes HappyHorse AI worth trying today? Discover features, pricing, pros, cons, and how HappyHo...

27. [HappyHorse AI Video Generator - Happy Horse 1.0 Model](https://www.happy-horseai.video) - HappyHorse is a free AI video generator powered by Happy Horse 1.0. Create 1080p videos from text or...

28. [Seedream 4.5 API: 4K Image Editing & Generation - EvoLink.AI](https://evolink.ai/seedream-4-5) - Use Seedream 4.5 API to generate and edit high-resolution images (up to 4K) with strong text renderi...

29. [Appendix - Recraft | AI](https://www.recraft.ai/docs/api-reference/appendix) - Aspect ratio ( w:h ): defines the proportional relationship between width and height without specify...

30. [Usage - Recraft | AI](https://www.recraft.ai/docs/api-reference/usage)
