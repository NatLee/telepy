# Terminal fonts

Web-terminal fonts the user can pick in Preferences → General → Terminal, or per device from the
terminal page's Appearance button (`src/lib/terminalAppearance.ts`). Each file is a **Nerd Font Mono**
cut of its family from [Nerd Fonts](https://www.nerdfonts.com/font-downloads) v3.5.1, converted
from TTF to WOFF2 with fontTools (no glyph changes). "Mono" keeps the Nerd Font icons one cell wide,
which is what a terminal grid needs. `src/app/terminal-fonts.css` declares them under one family name
per font with the matching `font-weight` / `font-style`; the browser only downloads a face when a
terminal draws text with it (Regular on open, Bold on the first bold cell, Italic on the first italic
one), so the Bold / Italic files cost nothing until they are used.

| Family | Files (`<name>-{Regular,Bold,Italic,BoldItalic}.woff2`) | Faces | Ligatures | Upstream | License |
| --- | --- | --- | --- | --- | --- |
| Hack Nerd Font Mono (default) | `HackNerdFontMono-*` | Regular, Bold, Italic, Bold Italic | no | [source-foundry/Hack](https://github.com/source-foundry/Hack) 3.003 | MIT + Bitstream Vera, `Hack-LICENSE.md` |
| JetBrainsMono NFM | `JetBrainsMonoNerdFontMono-*` | Regular, Bold, Italic, Bold Italic | yes | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) 2.304 | SIL OFL 1.1, `JetBrainsMono-OFL.md` |
| FiraCode Nerd Font Mono | `FiraCodeNerdFontMono-*` | Regular, Bold (Fira Code has no italic; the browser slants it) | yes | [tonsky/FiraCode](https://github.com/tonsky/FiraCode) 6.002 | SIL OFL 1.1, `FiraCode-OFL.md` |
| CaskaydiaCove NFM (Cascadia Code) | `CaskaydiaCoveNerdFontMono-*` | Regular, Bold, Italic, Bold Italic | yes | [microsoft/cascadia-code](https://github.com/microsoft/cascadia-code) 2407.24 | SIL OFL 1.1, `CascadiaCode-OFL.md` |
| MesloLGS Nerd Font Mono | `MesloLGSNerdFontMono-*` | Regular, Bold, Italic, Bold Italic | no | [andreberg/Meslo-Font](https://github.com/andreberg/Meslo-Font) 1.21 | Apache 2.0, `Meslo-LICENSE.md` |

A license covers every cut of its family. The license files are `.md` because the frontend `.gitignore`
drops `*.txt`. The Nerd Fonts icon glyphs come from the icon sets listed in the Nerd Fonts repository,
each under its own license (MIT / OFL / Apache 2.0 / CC BY 4.0). 0xProto, the previous terminal font,
stays in `src/fonts/` (`0xProtoNerdFont-{Regular,Bold,Italic}.woff2`, the non-Mono cut, declared by
`layout.tsx`'s next/font) because `font-mono` in the UI uses it; it has ligatures and no Bold Italic.
"Ligatures" = the font's `calt` feature joins sequences such as `->` (the terminal's Ligatures setting);
Hack and Meslo have none, so the setting does nothing with them.

To update a font, download the family's zip from the Nerd Fonts release page and convert each
`*NerdFontMono-{Regular,Bold,Italic,BoldItalic}.ttf` (0xProto: `0xProtoNerdFont-*.ttf`):

```bash
python3 -m pip install fonttools brotli
python3 -c "from fontTools.ttLib import TTFont; f=TTFont('HackNerdFontMono-Regular.ttf'); f.flavor='woff2'; f.save('HackNerdFontMono-Regular.woff2')"
```
