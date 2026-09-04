# Development guide

- This is a standalone Japanese-language web app for encoding 32×32 monochrome images and animations for Resonite.
- HTML, CSS, and JavaScript live in `index.html`. Preserve direct browser execution and avoid introducing build tools or external dependencies unless the task requires them.
- No dependency installation or build step is required. For browser checks, run `python3 -m http.server 8000 --bind 0.0.0.0` from the repository root.
- Preserve the encoding format: row-major pixels, UTF-16 code unit counting, 69 code units per Safe frame, and `/` between frames.
- For encoding changes, verify round trips for blank, filled, patterned, and multiple-frame inputs. For UI changes, exercise the affected controls and check browser console errors.
- Keep user-facing text in Japanese and explain any validation that could not be run.
