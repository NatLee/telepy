# Terminal fonts

Web-terminal fonts the user can pick in Preferences → General → Terminal, or per device from the
terminal page's Appearance button (`src/lib/terminalAppearance.ts`). Each file is the **Nerd Font Mono**
Regular of its family from [Nerd Fonts](https://www.nerdfonts.com/font-downloads) v3.5.1, converted
from TTF to WOFF2 with fontTools (no glyph changes). "Mono" keeps the Nerd Font icons one cell wide,
which is what a terminal grid needs. `src/app/terminal-fonts.css` declares them; the browser only
downloads the one a terminal actually uses.

| File | Family | Upstream | License |
| --- | --- | --- | --- |
| `HackNerdFontMono-Regular.woff2` | Hack Nerd Font Mono (default) | [source-foundry/Hack](https://github.com/source-foundry/Hack) 3.003 | MIT + Bitstream Vera, `Hack-LICENSE.md` |
| `JetBrainsMonoNerdFontMono-Regular.woff2` | JetBrainsMono NFM | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) 2.304 | SIL OFL 1.1, `JetBrainsMono-OFL.md` |
| `FiraCodeNerdFontMono-Regular.woff2` | FiraCode Nerd Font Mono | [tonsky/FiraCode](https://github.com/tonsky/FiraCode) 6.002 | SIL OFL 1.1, `FiraCode-OFL.md` |
| `CaskaydiaCoveNerdFontMono-Regular.woff2` | CaskaydiaCove NFM (Cascadia Code) | [microsoft/cascadia-code](https://github.com/microsoft/cascadia-code) 2407.24 | SIL OFL 1.1, `CascadiaCode-OFL.md` |
| `MesloLGSNerdFontMono-Regular.woff2` | MesloLGS Nerd Font Mono | [andreberg/Meslo-Font](https://github.com/andreberg/Meslo-Font) 1.21 | Apache 2.0, `Meslo-LICENSE.md` |

The license files are `.md` because the frontend `.gitignore` drops `*.txt`. The Nerd Fonts icon
glyphs come from the icon sets listed in the Nerd Fonts repository, each under its own license
(MIT / OFL / Apache 2.0 / CC BY 4.0). 0xProto, the previous terminal font, stays in `src/fonts/`
because `font-mono` in the UI uses it.

To update a font, download the family's zip from the Nerd Fonts release page and convert its
`*NerdFontMono-Regular.ttf`:

```bash
python3 -m pip install fonttools brotli
python3 -c "from fontTools.ttLib import TTFont; f=TTFont('HackNerdFontMono-Regular.ttf'); f.flavor='woff2'; f.save('HackNerdFontMono-Regular.woff2')"
```
