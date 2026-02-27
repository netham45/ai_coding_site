import "@testing-library/jest-dom/vitest";

// Chakra's focus-visible tracker monkey patches `focus` in ways jsdom may not allow.
// Make it writable in tests to prevent global mount crashes from checkbox components.
Object.defineProperty(HTMLElement.prototype, "focus", {
  configurable: true,
  writable: true,
  value() {}
});
