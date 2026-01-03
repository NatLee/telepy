## 2024-03-22 - Loading State Patterns
**Learning:** Users often click refresh buttons multiple times because they lack immediate feedback. CSS-only loading states using `color: transparent` and a pseudo-element spinner are a clean way to implement this without changing the DOM structure of the button content.
**Action:** Use the `.btn-loading` class for all async action buttons. Ensure the spinner color contrasts well with the button background or border (for outline buttons).
