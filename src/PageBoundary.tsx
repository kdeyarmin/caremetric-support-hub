import { Component, Suspense, type ReactNode } from "react";

/** Keep the shell usable when a page's code download fails, including after a new release. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <section className="panel" role="alert">
      <h1>This page could not be opened</h1>
      <p>Reload the page to get the latest version and try again.</p>
      <button className="button button-primary" onClick={() => window.location.reload()}>Reload page</button>
    </section>;
    return <Suspense fallback={<p role="status">Loading page…</p>}>{this.props.children}</Suspense>;
  }
}
