# Bundled OCR models

CoScribe bundles the official PaddleOCR PP-OCRv6 small ONNX archives so local
OCR works without a first-run model download.

- `PP-OCRv6_small_det_onnx_infer.tar`
  - SHA-256: `d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4`
  - Source: https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_det_onnx_infer.tar
- `PP-OCRv6_small_rec_onnx_infer.tar`
  - SHA-256: `d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1`
  - Source: https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_rec_onnx_infer.tar

PaddleOCR and these model assets are licensed under Apache-2.0. The full
license text is stored in `LICENSE-APACHE-2.0.txt`; bundled component notices
are recorded in the repository root `THIRD_PARTY_NOTICES.md`. The application
uses the WASM backend with one thread for portable macOS and Windows behavior.
