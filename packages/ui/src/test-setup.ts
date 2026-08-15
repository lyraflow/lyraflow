import '@testing-library/jest-dom/vitest'

// jsdom implements no Pointer Events capture API at all, and Radix's Select
// (and other popovers built on it) call these during open/close regardless
// of input method. Without a stub, clicking the trigger throws instead of
// opening the listbox -- not a Radix bug, a jsdom gap every Radix-based
// test in this package will otherwise hit.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
