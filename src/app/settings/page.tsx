"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisModelOption, EffortLevel } from "@/settings/contracts";
import {
  createSettingsPageController,
  type SettingsPageController,
  type SettingsPageControllerState,
} from "@/settings/writeQueue";
import { SettingsPageView } from "./SettingsPageView";

const INITIAL_STATE: SettingsPageControllerState = {
  status: "loading",
  payload: null,
  writer: null,
  error: null,
};

export default function SettingsPage() {
  const [state, setState] = useState<SettingsPageControllerState>(INITIAL_STATE);
  const controllerRef = useRef<SettingsPageController | null>(null);

  useEffect(() => {
    const controller = createSettingsPageController({
      fetcher: fetch,
      onState: setState,
    });
    controllerRef.current = controller;
    void controller.start();
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  const onAnalysisModel = useCallback((value: AnalysisModelOption) => {
    const controller = controllerRef.current;
    if (controller !== null) controller.setAnalysisModel(value);
  }, []);

  const onAnalysisEffort = useCallback((value: EffortLevel) => {
    const controller = controllerRef.current;
    if (controller !== null) controller.setAnalysisEffort(value);
  }, []);

  return (
    <SettingsPageView
      state={state}
      onAnalysisModel={onAnalysisModel}
      onAnalysisEffort={onAnalysisEffort}
    />
  );
}
