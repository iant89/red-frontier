# Models (Leonardo da Vinci GLB drop zone)

Logical asset ids in `src/render/assetCatalog.ts` map to URLs under this tree:

| Prefix | Path |
| --- | --- |
| `rover/*` | `rovers/<kind>.glb` |
| `building/*` | `buildings/<kind>.glb` |
| `prop/*` | `props/<name>.glb` |

Drop Leonardo-exported `.glb` files here matching those names. This repo does
**not** author or bake art — only the loading pipeline and a tiny fixture under
`_fixtures/` for unit tests. Missing or failed loads keep the Renderer’s
procedural meshes (gameplay/visual A/B identical with an empty tree).
