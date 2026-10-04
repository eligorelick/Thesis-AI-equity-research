"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { parseUiDesign, persistUiDesign, type UiDesign } from "./preference";

interface UiDesignState {
  design: UiDesign;
  saved: boolean | null;
  chooseDesign(design: UiDesign): void;
}

// Presentational components are also rendered independently in server tests.
// Their absence of a provider must preserve the original Current surface.
const UiDesignContext = createContext<UiDesignState>({
  design: "current", saved: null, chooseDesign: () => {},
});

export function UiDesignProvider({ initialDesign, children }: { initialDesign: UiDesign; children?: ReactNode }) {
  const [design, setDesign] = useState<UiDesign>(parseUiDesign(initialDesign));
  const [saved, setSaved] = useState<boolean | null>(null);
  // A server refresh may reconcile the body attribute from the cookie. Retain
  // the active visit's choice, including when cookie persistence was blocked.
  useEffect(() => { document.body.dataset.uiDesign = design; }, [design, initialDesign, children]);
  const chooseDesign = useCallback((value: UiDesign) => {
    const next = parseUiDesign(value);
    document.body.dataset.uiDesign = next;
    setDesign(next);
    setSaved(persistUiDesign(next, document, window.location.protocol === "https:"));
  }, []);
  return <UiDesignContext.Provider value={{ design, saved, chooseDesign }}>{children}</UiDesignContext.Provider>;
}

export function useUiDesign(): UiDesignState { return useContext(UiDesignContext); }

export function WorkspaceOnly({ children }: { children: ReactNode }) {
  return useUiDesign().design === "workspace" ? children : null;
}
