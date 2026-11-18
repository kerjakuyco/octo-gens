import { type Page, navigate, useApp } from "../state/app";
import { BrandMark } from "./BrandMark";
import { Icon, type IconName } from "./Icon";

const PAGES: { page: Page; label: string; icon: IconName }[] = [
  { page: "assistant", label: "Assistant", icon: "assistant" },
  { page: "portfolio", label: "Portfolio", icon: "portfolio" },
  { page: "connections", label: "Connections", icon: "connections" },
  { page: "activity", label: "Activity", icon: "activity" },
];

function NavItem({ page, label, icon, current }: { page: Page; label: string; icon: IconName; current: Page }) {
  return (
    <button
      type="button"
      className="nav-item"
      title={label}
      aria-current={current === page ? "page" : undefined}
      onClick={() => navigate(page)}
    >
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
    </button>
  );
}

/** The navigation rail. It keeps its labels until the window gets narrow. */
export function Rail() {
  const current = useApp((state) => state.page);
  return (
    <nav className="rail" aria-label="Main">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Octo Gens</span>
      </div>
      {PAGES.map((item) => (
        <NavItem key={item.page} {...item} current={current} />
      ))}
      <div className="rail-spacer" />
      <NavItem page="settings" label="Settings" icon="settings" current={current} />
    </nav>
  );
}
