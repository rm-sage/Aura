export type NavView = "home" | "library" | "addons" | "calendar" | "settings";

interface Props {
  active: NavView;
  onNavigate: (view: NavView) => void;
  /** Email of signed-in user; null when guest. */
  userEmail?: string | null;
  /** Optional Stremio account nickname. Wins over the email initial. */
  userNickname?: string | null;
  /** Click handler for the profile/'A' button. Should open the Login flow when guest. */
  onProfileClick?: () => void;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const HomeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
  </svg>
);

const LibraryIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z" />
  </svg>
);

const AddonsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z" />
  </svg>
);

const CalendarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z" />
  </svg>
);

const SettingsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Nav button
// ---------------------------------------------------------------------------

interface NavButtonProps {
  id: NavView;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}

function NavButton({ label, icon, active, onClick }: NavButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative w-10 h-10 rounded-xl flex items-center justify-center
                  transition-all duration-150
                  ${active
                    ? "bg-ln-accent/20 text-ln-accent"
                    : "text-white/35 hover:text-white/65 hover:bg-white/8"
                  }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5
                         bg-ln-accent rounded-r-full" />
      )}
      {icon}
    </button>
  );
}

// ---------------------------------------------------------------------------
// NavSidebar
// ---------------------------------------------------------------------------

const TOP_ITEMS: { id: NavView; label: string; icon: React.ReactNode }[] = [
  { id: "home",     label: "Home",     icon: <HomeIcon /> },
  { id: "library",  label: "Library",  icon: <LibraryIcon /> },
  { id: "addons",   label: "Addons",   icon: <AddonsIcon /> },
  { id: "calendar", label: "Calendar", icon: <CalendarIcon /> },
];

function profileInitial(email?: string | null, nickname?: string | null): string {
  const source = (nickname && nickname.trim()) || (email && email.trim()) || "";
  if (!source) return "A";
  return source.charAt(0).toUpperCase();
}

export default function NavSidebar({
  active,
  onNavigate,
  userEmail,
  userNickname,
  onProfileClick,
}: Props) {
  const loggedIn = !!userEmail;
  const initial = loggedIn ? profileInitial(userEmail, userNickname) : "A";
  const profileTitle = loggedIn
    ? `Signed in as ${userNickname ?? userEmail}`
    : "Sign in to Stremio";

  return (
    <div className="flex flex-col w-[60px] flex-shrink-0 glass-panel border-r border-white/8
                    items-center py-4 gap-1.5 select-none">
      {/* Profile button — Aura wordmark for guests, initial avatar for logged-in users */}
      <button
        onClick={onProfileClick}
        title={profileTitle}
        aria-label={profileTitle}
        className={`mb-3 w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0
                    transition-all duration-150
                    ${loggedIn
                      ? "bg-ln-accent/25 border border-ln-accent/40 hover:bg-ln-accent/35"
                      : "bg-ln-accent/15 border border-ln-accent/25 hover:bg-ln-accent/25"
                    }`}
      >
        <span className={`text-ln-accent font-bold tracking-tight
                         ${loggedIn ? "text-sm" : "text-[12px]"}`}>
          {initial}
        </span>
      </button>

      {/* Top nav */}
      {TOP_ITEMS.map((item) => (
        <NavButton
          key={item.id}
          {...item}
          active={active === item.id}
          onClick={() => onNavigate(item.id)}
        />
      ))}

      <div className="flex-1" />

      {/* Settings — pinned bottom */}
      <NavButton
        id="settings"
        label="Settings"
        icon={<SettingsIcon />}
        active={active === "settings"}
        onClick={() => onNavigate("settings")}
      />
    </div>
  );
}
