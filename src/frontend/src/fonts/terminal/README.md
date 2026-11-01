# Terminal fonts

These are the fonts people can pick for the web terminal, either in Preferences → Terminal or per device from the terminal's Appearance button.

Each one is the Nerd Font Mono cut of its family from [Nerd Fonts](https://www.nerdfonts.com/font-downloads) v3.5.1, converted from TTF to WOFF2 with fontTools. No glyphs were changed. "Mono" keeps the Nerd Font icons one cell wide, which is what a terminal grid needs.

The browser only downloads a face when a terminal actually draws text with it: Regular when a terminal opens, Bold at the first bold character, Italic at the first italic one. The Bold and Italic files cost nothing until then. If a font is installed on the computer, the browser uses that copy and downloads nothing at all.

| Family | Faces | Ligatures | Upstream | License |
| --- | --- | --- | --- | --- |
| Hack Nerd Font Mono (default) | Regular, Bold, Italic, Bold Italic | no | [source-foundry/Hack](https://github.com/source-foundry/Hack) 3.003 | MIT + Bitstream Vera, `Hack-LICENSE.md` |
| JetBrainsMono NFM | Regular, Bold, Italic, Bold Italic | yes | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) 2.304 | SIL OFL 1.1, `JetBrainsMono-OFL.md` |
| FiraCode Nerd Font Mono | Regular, Bold (no italic, the browser slants it) | yes | [tonsky/FiraCode](https://github.com/tonsky/FiraCode) 6.002 | SIL OFL 1.1, `FiraCode-OFL.md` |
| CaskaydiaCove NFM (Cascadia Code) | Regular, Bold, Italic, Bold Italic | yes | [microsoft/cascadia-code](https://github.com/microsoft/cascadia-code) 2407.24 | SIL OFL 1.1, `CascadiaCode-OFL.md` |
| MesloLGS Nerd Font Mono | Regular, Bold, Italic, Bold Italic | no | [andreberg/Meslo-Font](https://github.com/andreberg/Meslo-Font) 1.21 | Apache 2.0, `Meslo-LICENSE.md` |

File names follow `<family>-{Regular,Bold,Italic,BoldItalic}.woff2`, for example `HackNerdFontMono-Bold.woff2`.

## Licenses

- A license covers every cut of its family.
- The license files end in `.md` because the frontend ignores `*.txt` files in git.
- The Nerd Fonts icons come from the icon sets listed in the Nerd Fonts repository, each under its own license (MIT, OFL, Apache 2.0 or CC BY 4.0).

## Ligatures and 0xProto

"Ligatures" means the font joins sequences such as `->` into one symbol, which the terminal's Ligatures setting turns on. Hack and Meslo have none, so the setting does nothing with them.

0xProto, the previous terminal font, lives one folder up because the interface's own monospace text uses it. That copy is the regular Nerd Font cut (not Mono), with ligatures, and without a Bold Italic face.

## Updating a font

Download the family's zip from the Nerd Fonts release page and convert each `*NerdFontMono-{Regular,Bold,Italic,BoldItalic}.ttf` (for 0xProto: `0xProtoNerdFont-*.ttf`):

```bash
python3 -m pip install fonttools brotli
python3 -c "from fontTools.ttLib import TTFont; f=TTFont('HackNerdFontMono-Regular.ttf'); f.flavor='woff2'; f.save('HackNerdFontMono-Regular.woff2')"
```
