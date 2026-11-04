# maplibre-gl-handwriting

Freehand drawing on a [MapLibre GL JS](https://maplibre.org/) map. Strokes are kept in map coordinates, tessellated
off the main thread by [lyon](https://github.com/nical/lyon) compiled to WebAssembly, and drawn by a custom layer.
It comes with a pen, a highlighter, an eraser, a lasso to move, scale, rotate, duplicate or delete strokes, a laser
pointer, undo and redo, keyboard shortcuts and a toolbar control; the `tools` option chooses which tools a map
offers. `HandwritingLayer` draws the strokes alone, for maps that only show them.

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

`style.css` holds the toolbar's styles. The toolbar floats along an edge of the map, wherever its placement setting
says, not in the corner given to `addControl`.

`handwriting.ready` resolves once the WebAssembly module has loaded on the main thread and in the layer's
tessellation worker, which starts when the layer is added: after the style has loaded, and with `beforeId`, once the
style has that layer. When the module or the worker fails to load, `ready` rejects and the map fires an `error` event
with the layer's ID as `layerId` (on the console when nothing listens for it); the layer then draws nothing.

The package loads its worker and its WebAssembly module with `new URL('./…', import.meta.url)`, which Vite and
webpack 5 find by themselves; Rollup needs `@web/rollup-plugin-import-meta-assets`, and with esbuild copy the
package's `dist/assets` next to the bundle ([docs/usage.md](docs/usage.md#bundlers)). With Vite, exclude the package
from dependency pre-bundling, so that the dev server serves the worker and the module from where the package looks
for them:

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ['maplibre-gl-handwriting'] },
})
```

[examples/basic](examples/basic) is a complete Vite project; [examples/webpack](examples/webpack),
[examples/rollup](examples/rollup) and [examples/esbuild](examples/esbuild) are the same with the other bundlers.

To only show strokes, add a `HandwritingLayer` yourself, anywhere among the style's layers:

```ts
import { HandwritingLayer, StrokeStore } from 'maplibre-gl-handwriting'

const store = new StrokeStore()
map.on('load', () => map.addLayer(new HandwritingLayer({ store, id: 'strokes' })))
```

After a `setStyle` that rebuilds the style, add it again; call `destroy()` when it is no longer needed, also after
`map.remove()`. `createHandwriting` adds its own layer again by itself.

## Documentation

[docs/usage.md](docs/usage.md) covers the options, the handle's functions and events, the toolbar, the
`HandwritingLayer`, the store and its order modes, saving settings, the `maplibre-gl-handwriting/core` entry and
bundler setup.

## Versioning

The package is at 0.x. A release that changes the public API raises the minor version, any other release the patch
version ([CHANGELOG.md](CHANGELOG.md)). The features under the `experimental` option are being worked on and are
outside semantic versioning: they may change or be removed in any release.

## License

MIT ([LICENSE](LICENSE)). The WebAssembly module includes Rust crates under their own licenses
([THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)).
