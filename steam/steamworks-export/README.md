# Red Frontier — Steamworks Export Folder

Ready-to-upload graphical assets, sized to Steam's exact requirements.
Derived from the high-resolution masters in `../assets/` (those stay
untouched — re-crop or re-export from them anytime).

| File | Steamworks slot | Size |
|---|---|---|
| `capsule-header-460x215.jpg` | Header Capsule (required) | 460×215 |
| `capsule-header-920x430.jpg` | Header Capsule @2× | 920×430 |
| `capsule-small-231x87.jpg` | Small Capsule (required) | 231×87 |
| `capsule-small-462x174.jpg` | Small Capsule @2× | 462×174 |
| `capsule-main-616x353.jpg` | Main Capsule (required) | 616×353 |
| `capsule-main-1232x706.jpg` | Main Capsule @2× | 1232×706 |
| `capsule-vertical-374x448.jpg` | Vertical / Hero Capsule | 374×448 |
| `library-capsule-600x900.jpg` | Library Capsule | 600×900 |
| `library-hero-1920x620.jpg` | Library Hero | 1920×620 |
| `library-hero-3840x1240.jpg` | Library Hero (max-res option, upscaled) | 3840×1240 |
| `library-logo-1280x720.png` | Library Logo (transparent, 1010×720 within the 1280×720 limit) | ≤1280×720 |
| `page-background-1438x810.jpg` | Store page background | 1438×810 |
| `community-icon-184x184.png` | Community Icon | 184×184 |
| `community-icon-32x32.png` | Community Icon (small variant) | 32×32 |
| `red-frontier-client.ico` | Client Icon (multi-size 16/32/64) | .ico |
| `client-icon-{16,32,64}x{16,32,64}.{png,tga}` | Client Icon, individual sizes | 16/32/64 |

Notes

- Capsules carry only the title + in-world brand lockup — compliant with
  Valve's September 2022 imagery rules (no review scores, awards, or
  marketing text on base capsules).
- `library-hero-*.jpg` contains no text, per Steam library hero rules.
- `library-logo-1280x720.png` is transparent with ~10% padding baked in so
  the lockup never touches Steam's hero crop edges.
- If Valve rejects the upscaled 3840×1240 hero, upload the 1920×620
  version — both are accepted; 3840 is optional HD.
