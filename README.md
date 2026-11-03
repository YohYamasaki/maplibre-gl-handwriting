# maplibre-gl-handwriting

Freehand drawing on a [MapLibre GL JS](https://maplibre.org/) map. Strokes are kept in map coordinates, tessellated
off the main thread by [lyon](https://github.com/nical/lyon) compiled to WebAssembly, and drawn by a custom layer.
It comes with a pen, a highlighter, an eraser, a lasso to move, scale, rotate, duplicate or delete strokes, a laser
pointer, undo and redo, keyboard shortcuts and a toolbar control.

The package draws and edits the strokes of a store you own. It does not save or share them: keep the store's
strokes yourself, or connect the store to your own sync layer.

## Install

```sh
npm install maplibre-gl maplibre-gl-handwriting
```

`maplibre-gl` (^6.16.0) is a peer dependency.

## Usage

```ts
import 'maplibre-gl/dist/maplibre-gl.css'
import 'maplibre-gl-handwriting/style.css'
import { Map } from 'maplibre-gl'
import { createHandwriting, HandwritingToolbar, StrokeStore } from 'maplibre-gl-handwriting'

const map = new Map({ container: 'map', style: 'https://demotiles.maplibre.org/style.json' })

const store = new StrokeStore()
const handwriting = createHandwriting(map, { store })
handwriting.setTool('pen')
map.addControl(new HandwritingToolbar(handwriting))
```

`style.css` holds the toolbar's styles. With Vite, exclude the package from dependency pre-bundling, so that its
tessellation worker and WebAssembly module are served from where the package looks for them:

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ['maplibre-gl-handwriting'] },
})
```

[examples/basic](examples/basic) is a complete Vite project.

## Documentation

[docs/usage.md](docs/usage.md) covers the options, the handle's functions and events, the store and its order
modes, saving settings, the `maplibre-gl-handwriting/core` entry and bundler setup.

## Versioning

The package is at 0.x. A release that changes the public API raises the minor version, any other release the patch
version ([CHANGELOG.md](CHANGELOG.md)). The features under the `experimental` option are being worked on and are
outside semantic versioning: they may change or be removed in any release.

## License

MIT ([LICENSE](LICENSE)). The WebAssembly module includes Rust crates under their own licenses
([THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)).
