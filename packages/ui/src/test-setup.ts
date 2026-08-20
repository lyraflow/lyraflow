import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'

// One jsdom serves every test in a file, so localStorage is shared state --
// unlike a browser, where each page load starts clean. Two things in this app
// persist there: the theme, and (since the project switcher started surviving
// a reload) the active project. Without this, a test that switches project
// silently decides which project the NEXT test's provider opens on, which is
// a failure that reads as a bug in the screen under test rather than as
// leakage from the one before it.
beforeEach(() => localStorage.clear())

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
