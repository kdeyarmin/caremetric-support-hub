import {
  Activity,
  Bot,
  BookOpen,
  Boxes,
  Building2,
  CreditCard,
  FileText,
  Gauge,
  GraduationCap,
  Inbox,
  LayoutDashboard,
  Library,
  Link2,
  MailPlus,
  MessagesSquare,
  Phone,
  Rocket,
  Settings2,
  ShieldCheck,
  UserRound,
  Voicemail,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

export type NavAudience = "everyone" | "staff" | "platformAdmin" | "organizationBilling";
export interface NavItem { to: string; label: string; icon: LucideIcon; audience?: NavAudience; end?: boolean }
export interface NavSection { label: string; items: readonly NavItem[] }
export interface NavViewer { staff: boolean; platformAdmin: boolean; organizationBilling: boolean }

/** The sidebar groups pages by job: home first, then the work each role does most, then the person's own account. Only platform administrators author courses, so only they see Course authoring. */
export const navSections: readonly NavSection[] = [
  { label: "Home", items: [
    { to: "/admin", label: "Control center", icon: Gauge, audience: "platformAdmin", end: true },
    { to: "/overview", label: "Overview", icon: LayoutDashboard },
  ] },
  { label: "Administration", items: [
    { to: "/admin/apps", label: "Applications", icon: Boxes, audience: "platformAdmin" },
    { to: "/admin/leads", label: "Leads", icon: UserPlus, audience: "platformAdmin" },
    { to: "/admin/billing", label: "Billing", icon: CreditCard, audience: "platformAdmin" },
    { to: "/admin/email", label: "Bulk email", icon: MailPlus, audience: "platformAdmin" },
    { to: "/phone-numbers", label: "Phone numbers", icon: Phone, audience: "platformAdmin" },
    { to: "/admin/portfolio", label: "Portfolio rollup", icon: Activity, audience: "platformAdmin" },
    { to: "/admin/go-live-readiness", label: "AI go-live readiness", icon: Rocket, audience: "platformAdmin" },
    { to: "/admin/growth", label: "Customer growth", icon: Bot, audience: "platformAdmin" },
    { to: "/admin/team", label: "AI team", icon: Bot, audience: "platformAdmin" },
  ] },
  { label: "Support", items: [
    { to: "/cases", label: "Support cases", icon: Inbox },
    { to: "/communications", label: "Communications", icon: MessagesSquare, audience: "staff" },
    { to: "/phone", label: "Phone messages", icon: Voicemail, audience: "platformAdmin" },
  ] },
  { label: "Help & learning", items: [
    { to: "/knowledge", label: "Knowledge", icon: FileText },
    { to: "/manuals", label: "User manuals", icon: BookOpen },
    { to: "/learn", label: "Learning library", icon: GraduationCap },
    { to: "/library", label: "Course authoring", icon: Library, audience: "platformAdmin" },
  ] },
  { label: "Platform", items: [
    { to: "/products", label: "Products & contacts", icon: Building2 },
    { to: "/integration", label: "App integration", icon: Link2 },
  ] },
  { label: "My account", items: [
    { to: "/self-service", label: "Customer center", icon: Settings2 },
    { to: "/account/profile", label: "My profile & training", icon: UserRound },
    { to: "/billing", label: "Billing", icon: CreditCard, audience: "organizationBilling" },
    { to: "/security", label: "Security", icon: ShieldCheck },
  ] },
];

const unlistedPageTitles: Record<string, string> = { "/help": "Help", "/subscriptions": "Subscriptions", "/imports/docstudio": "Review material imports" };

/** The sections and links one person may open; a section with nothing left in it is dropped. */
export function visibleNavSections(viewer: NavViewer): NavSection[] {
  const visible = (audience: NavAudience = "everyone") => audience === "everyone"
    || (audience === "staff" && viewer.staff)
    || (audience === "platformAdmin" && viewer.platformAdmin)
    || (audience === "organizationBilling" && viewer.organizationBilling);
  return navSections
    .map((section) => ({ ...section, items: section.items.filter((item) => visible(item.audience)) }))
    .filter((section) => section.items.length);
}

/** The page the address belongs to, matched the way the sidebar highlights it: the longest link that is the path or one of its parents. */
export function currentPage(sections: readonly NavSection[], pathname: string): { section: string; label: string } | null {
  let match: { section: string; item: NavItem } | null = null;
  for (const section of sections) for (const item of section.items) {
    const matches = pathname === item.to || (!item.end && pathname.startsWith(`${item.to}/`));
    if (matches && (!match || item.to.length > match.item.to.length)) match = { section: section.label, item };
  }
  if (match) return { section: match.section, label: match.item.label };
  return unlistedPageTitles[pathname] ? { section: "", label: unlistedPageTitles[pathname] } : null;
}
