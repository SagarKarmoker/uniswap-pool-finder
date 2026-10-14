import "./app.js";

// Minimal HMR entry so edits to app.js hot-reload in Vite during development.
if (import.meta.hot) {
  import.meta.hot.accept();
}