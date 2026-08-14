/**
 * Line-icon set with path data lifted directly from borla_UI_design.html, so the real app uses
 * the exact same icon language as the approved mockups instead of emoji standing in for them.
 */
type IconProps = { size?: number; color?: string; strokeWidth?: number };

const base = (size: number) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none" as const });

export function IconBack({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M15 5l-7 7 7 7" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconClose({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 6l12 12M18 6L6 18" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSearch({ size = 18, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="11" cy="11" r="7" stroke={color} strokeWidth={2.2} />
      <path d="M20 20l-3.2-3.2" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}

export function IconPin({ size = 18, color = "var(--green)" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 21s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12Z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <circle cx="12" cy="9" r="2.4" fill={color} />
    </svg>
  );
}

export function IconTrash({ size = 22, color = "#fff" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 3h6l1 3H8l1-3Z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <path d="M6 6h12l-1 13.5a1.5 1.5 0 0 1-1.5 1.4H8.5A1.5 1.5 0 0 1 7 19.5L6 6Z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}

export function IconRecycle({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7 8l2-3 2 3M17 11l2 3-3 1M9 19l-3-1 1-3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 5h4l2 3M19 14l-1 4-4 0M6 18l-2-3 2-3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.4} />
    </svg>
  );
}

export function IconBox({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4" y="8" width="16" height="11" rx="1.5" stroke={color} strokeWidth={2} />
      <path d="M4 12h16M9 8V5h6v3" stroke={color} strokeWidth={2} />
    </svg>
  );
}

export function IconLeaf({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path
        d="M12 20c4-1 6-4 6-8 0-1.5-1-3-1-3s-2 1-3 3c0-3-2-6-2-6s-2 3-2 6c-1-2-3-3-3-3s-1 1.5-1 3c0 4 2 7 6 8Z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconStar({ size = 14, filled = true, color = "#F5A208" }: IconProps & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : "none"}>
      <path
        d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"
        stroke={filled ? "none" : "#D0CFC4"}
        strokeWidth={filled ? 0 : 1.6}
      />
    </svg>
  );
}

export function IconCheck({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 12l5 5 9-11" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconPhone({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path
        d="M6 4h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 5 6a2 2 0 0 1 1-2Z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPower({ size = 40, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3v9" stroke={color} strokeWidth={2.6} strokeLinecap="round" />
      <path d="M6.5 6.5a8 8 0 1 0 11 0" stroke={color} strokeWidth={2.6} strokeLinecap="round" />
    </svg>
  );
}

export function IconHome({ size = 22, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-8Z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}

export function IconPerson({ size = 22, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="8" r="4" stroke={color} strokeWidth={2} />
      <path d="M5 20a7 7 0 0 1 14 0" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export function IconShield({ size = 14, color = "#6B7A70" }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4" y="10" width="16" height="10" rx="2" stroke={color} strokeWidth={2} />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke={color} strokeWidth={2} />
    </svg>
  );
}

export function IconTruck({ size = 22, color = "currentColor" }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 7h10v9H3z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <path d="M13 11h4l3 3v2h-7z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <circle cx="7" cy="18" r="1.8" fill={color} />
      <circle cx="16.5" cy="18" r="1.8" fill={color} />
    </svg>
  );
}

export function IconClock({ size = 22, color = "#D98A00" }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth={2} />
      <path d="M12 7v5l3 2" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
