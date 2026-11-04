/**
 * Whether the development tools' code is in the build: replaced by the build, false in the package,
 * true on the dev page and in the tests. Code under `if (__HANDWRITING_DEBUG__)` is removed from the package
 */
declare const __HANDWRITING_DEBUG__: boolean
