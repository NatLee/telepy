## 2024-05-23 - Robust Button Loading States
**Learning:** Using `color: transparent` on a button to hide text during loading is fragile if the text has shadows or if children elements (icons) inherit colors differently.
**Action:** For robust loading states, use `.btn-loading > * { visibility: hidden; }` to reliably hide all content, and ensure `text-shadow: none !important` is applied to the button itself to remove any lingering text effects.
