export default function LightTrails() {
  return (
    <div className="light-trails" aria-hidden="true">
      <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="trail-color" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#9c0010" stopOpacity="0" />
            <stop offset=".4" stopColor="#d50014" />
            <stop offset=".7" stopColor="#f00920" />
            <stop offset="1" stopColor="#a80013" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="trail-field">
          {Array.from({ length: 24 }, (_, i) => {
            const path = `M -160 ${950 + i * 23} C ${460 + i * 5} ${470 + i * 20}, ${940 - i * 12} ${1060 - i * 27}, ${1680 - i * 3} ${-260 + i * 22}`;
            return <g key={i}>
              <path d={path} className="trail-line" />
              {i % 3 === 0 && <path d={path} pathLength="100" className="trail-pulse" style={{ animationDelay: `${-i * .7}s`, animationDuration: `${9 + i / 3}s` }} />}
            </g>;
          })}
        </g>
      </svg>
    </div>
  );
}
