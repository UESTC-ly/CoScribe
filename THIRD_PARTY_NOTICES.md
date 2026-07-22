# Third-Party Notices

CoScribe includes the following third-party components in its OCR and DOCX
features. Copyright remains with the respective authors.

## PaddleOCR.js and PP-OCRv6 Small models

- Components: `@paddleocr/paddleocr-js` 0.4.2, PP-OCRv6 Small detection model,
  PP-OCRv6 Small recognition model
- Copyright: PaddlePaddle Authors
- License: Apache License 2.0
- Project: https://github.com/PaddlePaddle/PaddleOCR
- Model sources and SHA-256 checksums: `resources/ocr/README.md`
- Full license text: `resources/ocr/LICENSE-APACHE-2.0.txt`

## OpenCV.js

- Component: `@techstark/opencv-js` 4.10.0-release.1
- License: Apache License 2.0
- Project: https://github.com/TechStark/opencv-js
- Full license text: `resources/ocr/LICENSE-APACHE-2.0.txt`

## ONNX Runtime Web

- Component: `onnxruntime-web` 1.27.0
- Copyright: Microsoft Corporation
- License: MIT
- Project: https://github.com/microsoft/onnxruntime

## sherpa-onnx and bilingual Zipformer ASR model

- Components: `sherpa-onnx-node` 1.12.40 and the int8 small streaming
  Chinese-English Zipformer model
- Copyright: k2-fsa / next-gen Kaldi contributors and model contributors
- License: Apache License 2.0
- Projects: https://github.com/k2-fsa/sherpa-onnx and
  https://huggingface.co/csukuangfj/k2fsa-zipformer-bilingual-zh-en-t
- Bundled model files and checksums: `scripts/fetch-asr-model.mjs`
- Full license text: `resources/ocr/LICENSE-APACHE-2.0.txt`

## Mammoth

- Component: `mammoth` 1.12.0
- Copyright: Michael Williamson
- License: BSD 2-Clause
- Project: https://github.com/mwilliamson/mammoth.js

## DOMPurify

- Component: `dompurify` 3.4.12
- Copyright: Mario Heiderich and contributors
- License: Mozilla Public License 2.0 or Apache License 2.0
- Project: https://github.com/cure53/DOMPurify

## highlight.js

- Component: `highlight.js` 11.11.1
- Copyright: Ivan Sagalaev and contributors
- License: BSD 3-Clause
- Project: https://github.com/highlightjs/highlight.js

## JSZip

- Component: `jszip` 3.10.1, used transitively by Mammoth
- Copyright: Stuart Knightley, David Duponchel, Franz Buchinger, Antonio Afonso
- License selected for this distribution: MIT
- Project: https://github.com/Stuk/jszip

Electron's own license and Chromium third-party notices are included separately
by electron-builder in each packaged application.
