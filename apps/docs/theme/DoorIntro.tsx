import { useEffect, useRef } from 'react';
import { createDoorIntro, type DoorIntroController } from './door-intro';
import './intro.css';

type Props = { active: boolean; translate: (key: string) => string; language: string };

export function DoorIntro({ active, translate, language }: Props) {
  const anchor = useRef<HTMLDivElement>(null);
  const controller = useRef<DoorIntroController | null>(null);
  const copy = useRef(translate);
  copy.current = translate;
  useEffect(() => {
    const stage = anchor.current?.parentElement;
    if (!stage) return;
    controller.current = createDoorIntro(stage, { active, translate: key => copy.current(key) });
    return () => {
      controller.current?.destroy();
      controller.current = null;
    };
  }, []);
  useEffect(() => { controller.current?.setActive(active); }, [active]);
  useEffect(() => { controller.current?.refresh(); }, [language]);
  return <>
    <div ref={anchor} hidden />
<div className="door-intro" aria-hidden="true">
          <div className="door-camera">
            <svg className="door-symbol" xmlns="http://www.w3.org/2000/svg" width="360" height="336" viewBox="0 0 360 336" aria-hidden="true" focusable="false">

              <g className="door-frame">
                <path fill="#252823" d="M44 324Q32 324 32 312V154C32 94 84 52 150 52C216 52 268 94 268 154V312Q268 324 256 324H224Q212 324 212 312V153C212 116 185 104 150 104C115 104 92 116 92 153V312Q92 324 80 324Z"/>
              </g>
              <g className="door-leaf">
                <path fill="#D89945" fillRule="evenodd" d="M111 135C105 133 101 137 101 143V313C101 319 105 322 112 319L180 300Q187 298 187 290V167Q187 159 180 157ZM176 229A11 11 0 1 0 154 229A11 11 0 1 0 176 229Z"/>
                <circle cx="165" cy="229" r="11" fill="#252823"/>
              </g>
              <g className="door-knock-marks">
                <path fill="none" stroke="#D89945" strokeWidth="21" strokeLinecap="round" d="M259 65L280 31M286 94L316 74"/>
              </g>

              <g className="door-waves" fill="none" stroke="#D89945" strokeWidth="7" strokeLinecap="round">
                <path className="knock-wave knock-wave-one" d="M259 65L280 31M286 94L316 74"/>
                <path className="knock-wave knock-wave-two" d="M259 65L280 31M286 94L316 74"/>
                <path className="knock-wave knock-wave-three" d="M259 65L280 31M286 94L316 74"/>
              </g>
            </svg>
          </div>
        </div>
        <div className="intro-controls" role="group" aria-label={translate('intro.controls')}  hidden>
          <button type="button" data-intro-action="pause">{translate('intro.pause')}</button>
          <button type="button" data-intro-action="skip">{translate('intro.skip')}</button>
          <button type="button" data-intro-action="replay" hidden>{translate('intro.replay')}</button>
        </div>

  </>;
}
