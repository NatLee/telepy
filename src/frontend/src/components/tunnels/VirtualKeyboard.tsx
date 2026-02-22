import React, { useState } from 'react';

interface VirtualKeyboardProps {
    onInput: (input: string) => void;
    isExpanded?: boolean;
    isVisible?: boolean;
    onToggle?: () => void;
}

export function VirtualKeyboard({ onInput, isExpanded = true, isVisible = true, onToggle }: VirtualKeyboardProps) {
    const [isCtrl, setIsCtrl] = useState(false);
    const [isShift, setIsShift] = useState(false);
    const [isSym, setIsSym] = useState(false);

    const handleKey = (char: string) => {
        let out = char;
        if (isCtrl) {
            const code = char.toLowerCase().charCodeAt(0);
            if (code >= 97 && code <= 122) { // a-z
                out = String.fromCharCode(code - 96);
            }
            setIsCtrl(false);
        }
        onInput(out);
        if (isShift) setIsShift(false); // auto-turn off shift after typing a key
    };

    const renderKey = (normal: string, shifted: string, sym: string, widthClass = "flex-1") => {
        let display = normal;
        let output = normal;

        if (isSym) {
            display = sym;
            output = sym;
        } else if (isShift) {
            display = shifted;
            output = shifted;
        }

        if (!display) {
            return <div className={`m-0.5 ${widthClass}`} style={{ visibility: 'hidden' }} />;
        }

        return (
            <button
                aria-label={`Key ${display}`}
                className={`h-9 px-0 min-w-0 ${widthClass} bg-secondary active:bg-secondary/80 active:scale-[0.96] text-secondary-foreground rounded shadow-[0_1px_1px_rgba(0,0,0,0.5)] select-none flex items-center justify-center m-0.5 text-[17px] transition-all duration-75 font-sans`}
                onPointerDown={(e) => { e.preventDefault(); handleKey(output); }}
            >
                {display}
            </button>
        );
    };

    return (
        <div className={`md:hidden absolute w-full left-0 bottom-0 z-[100] transition-transform duration-300 ease-in-out ${isVisible ? 'translate-y-0' : 'translate-y-full pointer-events-none'}`}>
            <div className={`bg-background p-1.5 border-t border-border w-full flex flex-col max-w-[100vw] ${isExpanded ? 'pb-4' : 'pb-2'} shadow-[0_-4px_20px_rgba(0,0,0,0.6)] transition-all`}>

                {/* Toggle Handle inside the keyboard now */}
                {onToggle && (
                    <div className="flex justify-center w-full mb-1.5">
                        <button
                            onClick={(e) => { e.preventDefault(); onToggle(); }}
                            className="bg-muted border border-border w-16 h-1.5 rounded-full shadow-inner flex items-center justify-center active:bg-muted/80 transition-colors"
                            aria-label={isExpanded ? "Collapse Keyboard" : "Expand Keyboard"}
                        />
                    </div>
                )}

                {/* Top row: controls and arrows (Always visible) */}
                <div className="flex w-full justify-between items-center mb-1 gap-1 px-0.5">
                    <div className="flex gap-1 flex-1 bg-muted/50 p-1 rounded-lg shadow-inner">
                        <button aria-label="Control key" className={`h-8 flex-1 rounded text-xs font-bold select-none transition-all duration-75 active:scale-[0.96] ${isCtrl ? 'bg-primary text-primary-foreground' : 'bg-secondary active:bg-secondary/80 text-secondary-foreground'}`} onPointerDown={(e) => { e.preventDefault(); setIsCtrl(!isCtrl); }}>CTRL</button>
                        <button aria-label="Escape key" className="h-8 flex-1 rounded text-xs font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.96] transition-all duration-75 text-secondary-foreground" onPointerDown={(e) => { e.preventDefault(); onInput("\x1b"); }}>ESC</button>
                        <button aria-label="Tab key" className="h-8 flex-1 rounded text-xs font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.96] transition-all duration-75 text-secondary-foreground" onPointerDown={(e) => { e.preventDefault(); onInput("\t"); }}>TAB</button>
                    </div>
                    <div className="flex gap-1 flex-1 bg-muted/50 p-1 rounded-lg justify-center shadow-inner">
                        <button aria-label="Up arrow" className="h-8 flex-1 rounded font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.96] transition-all duration-75 text-secondary-foreground" onPointerDown={(e) => { e.preventDefault(); onInput("\x1b[A"); }}>↑</button>
                        <button aria-label="Down arrow" className="h-8 flex-1 rounded font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.96] transition-all duration-75 text-secondary-foreground" onPointerDown={(e) => { e.preventDefault(); onInput("\x1b[B"); }}>↓</button>
                        <button aria-label="Left arrow" className="h-8 flex-1 rounded font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.96] transition-all duration-75 text-secondary-foreground" onPointerDown={(e) => { e.preventDefault(); onInput("\x1b[D"); }}>←</button>
                        <button aria-label="Right arrow" className="h-8 flex-1 rounded font-bold select-none bg-secondary active:bg-secondary/80 active:scale-[0.96] transition-all duration-75 text-secondary-foreground" onPointerDown={(e) => { e.preventDefault(); onInput("\x1b[C"); }}>→</button>
                    </div>
                </div>

                {/* Key rows (Animated conditionally visible) */}
                <div
                    className={`grid transition-all duration-300 ease-in-out ${isExpanded ? 'grid-rows-[1fr] opacity-100 mt-1' : 'grid-rows-[0fr] opacity-0 mt-0 pointer-events-none'}`}
                >
                    <div className="flex flex-col gap-1 overflow-hidden min-h-0">
                        <div className="flex w-full">
                            {renderKey('1', '!', '1')} {renderKey('2', '@', '2')} {renderKey('3', '#', '3')} {renderKey('4', '$', '4')} {renderKey('5', '%', '5')} {renderKey('6', '^', '6')} {renderKey('7', '&', '7')} {renderKey('8', '*', '8')} {renderKey('9', '(', '9')} {renderKey('0', ')', '0')}
                        </div>
                        <div className="flex w-full">
                            {renderKey('q', 'Q', '-')} {renderKey('w', 'W', '/')} {renderKey('e', 'E', ':')} {renderKey('r', 'R', ';')} {renderKey('t', 'T', '(')} {renderKey('y', 'Y', ')')} {renderKey('u', 'U', '$')} {renderKey('i', 'I', '&')} {renderKey('o', 'O', '@')} {renderKey('p', 'P', '"')}
                        </div>
                        <div className="flex w-full px-[4%]">
                            {renderKey('a', 'A', '[')} {renderKey('s', 'S', ']')} {renderKey('d', 'D', '{')} {renderKey('f', 'F', '}')} {renderKey('g', 'G', '#')} {renderKey('h', 'H', '%')} {renderKey('j', 'J', '^')} {renderKey('k', 'K', '*')} {renderKey('l', 'L', '+')}
                        </div>
                        <div className="flex w-full">
                            <button aria-label="Shift key" className={`h-9 px-0 flex-[1.2] rounded text-lg font-medium select-none m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)] flex items-center justify-center transition-all duration-75 active:scale-[0.96] ${isShift ? 'bg-primary text-primary-foreground' : 'bg-secondary active:bg-secondary/80 text-secondary-foreground'}`} onPointerDown={(e) => { e.preventDefault(); setIsShift(!isShift); }}>⇧</button>
                            {renderKey('z', 'Z', '_')} {renderKey('x', 'X', '=')} {renderKey('c', 'C', '|')} {renderKey('v', 'V', '~')} {renderKey('b', 'B', '\\')} {renderKey('n', 'N', '?')} {renderKey('m', 'M', '!')} {renderKey(',', '<', ',')} {renderKey('.', '>', '.')}
                            <button aria-label="Backspace key" className="h-9 px-0 flex-[1.2] rounded text-lg font-medium select-none bg-secondary active:bg-secondary/80 active:scale-[0.96] transition-all duration-75 text-secondary-foreground m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)] flex items-center justify-center" onPointerDown={(e) => { e.preventDefault(); onInput("\x7f"); }}>⌫</button>
                        </div>
                        <div className="flex w-full">
                            <button aria-label="Symbols toggle key" className={`h-9 px-0 flex-[1.5] rounded text-sm font-bold select-none m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)] transition-all duration-75 active:scale-[0.96] ${isSym ? 'bg-primary text-primary-foreground' : 'bg-secondary active:bg-secondary/80 text-secondary-foreground'}`} onPointerDown={(e) => { e.preventDefault(); setIsSym(!isSym); }}>123</button>
                            <button aria-label="Space key" className="h-9 px-0 flex-grow-[4] rounded text-lg select-none bg-secondary active:bg-secondary/80 active:scale-[0.96] transition-all duration-75 text-secondary-foreground m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)]" onPointerDown={(e) => { e.preventDefault(); onInput(" "); }}>space</button>
                            <button aria-label="Return key" className="h-9 px-0 flex-[1.5] rounded text-sm font-bold select-none bg-primary hover:bg-primary/90 active:bg-primary/80 active:scale-[0.96] transition-all duration-75 text-primary-foreground m-0.5 shadow-[0_1px_1px_rgba(0,0,0,0.5)]" onPointerDown={(e) => { e.preventDefault(); onInput("\r"); }}>return</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
