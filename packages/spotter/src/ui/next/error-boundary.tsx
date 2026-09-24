"use client";
/**
 * `<SpotterErrorBoundary>` — a React error boundary that files the error
 * (with the component stack) through `captureException`, and gives the
 * fallback a one-call way to ask the user what happened:
 *
 * ```tsx
 * <SpotterErrorBoundary fallback={({ error, report, reset }) => (
 *   <div role="alert">
 *     <p>Something broke.</p>
 *     <button onClick={report}>Tell us what you were doing</button>
 *     <button onClick={reset}>Try again</button>
 *   </div>
 * )}>
 *   <Checkout />
 * </SpotterErrorBoundary>
 * ```
 *
 * `report()` opens the widget with the description prefilled, so the
 * reporter's words land next to the captured error.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import * as bridge from "./internal/bridge.ts";
import { ensureClient, startFlow } from "./internal/controller.ts";

export interface SpotterFallbackProps {
  error: Error;
  /** Open the widget, prefilled. */
  report: () => void;
  /** Clear the error and re-render the children. */
  reset: () => void;
}

export interface SpotterErrorBoundaryProps {
  children?: ReactNode;
  fallback?: ReactNode | ((props: SpotterFallbackProps) => ReactNode);
  /** Prefill for `report()`. Default: the localized "Something broke. Tell us what you were doing?". */
  prefill?: { title?: string; description?: string };
  /** Tags on the captured exception. */
  tags?: Record<string, string>;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class SpotterErrorBoundary extends Component<SpotterErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    void ensureClient()
      .then((c) =>
        c.captureException(error, {
          componentStack: info.componentStack ?? null,
          mechanism: "boundary",
          ...(this.props.tags ? { tags: this.props.tags } : {}),
        }),
      )
      .catch(() => {
        /* reporting must never throw from a boundary */
      });
  }

  private reset = () => this.setState({ error: null });

  private report = () => {
    const error = this.state.error;
    const title = this.props.prefill?.title ?? (error ? `${error.name}: ${error.message}`.slice(0, 140) : undefined);
    const prefill = {
      title,
      // Undefined description → the panel uses its localized boundary prompt.
      description: this.props.prefill?.description,
      category: "bug" as const,
    };
    startFlow({ prefill }, null, null, "boundary");
    try {
      bridge.peekClient()?.open({ prefill }); // for `on('open')` listeners; the flow is already open
    } catch {
      /* mirror only */
    }
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback({ error, report: this.report, reset: this.reset });
    if (fallback !== undefined) return fallback;
    return null;
  }
}
