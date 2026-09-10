import {
  BaseRenderer,
  RendererThemeProvider,
  destroyForm,
  useBuildForm,
  useRendererQueryClient,
} from "@aehrc/smart-forms-renderer";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";

import type { Questionnaire, QuestionnaireResponse } from "fhir/r4";

export interface FormRendererProps {
  questionnaire: Questionnaire;
  questionnaireResponse?: QuestionnaireResponse;
  terminologyServerUrl?: string;
  readOnly?: boolean;
}

/**
 * Thin wrapper around the smart-forms rendering engine.
 *
 * `SmartFormsRenderer` is deprecated upstream; the supported composition is
 * `useBuildForm` + `RendererThemeProvider` + `BaseRenderer`, which is what this does.
 *
 * The renderer's questionnaire and response stores are module-level singletons, so the form must be
 * torn down on unmount - otherwise answers from the previous form leak into the next one.
 * @param props
 */
export default function FormRenderer(props: FormRendererProps) {
  const {
    questionnaire,
    questionnaireResponse,
    terminologyServerUrl,
    readOnly,
  } = props;

  const isBuilding = useBuildForm({
    questionnaire,
    questionnaireResponse,
    readOnly,
    terminologyServerUrl,
  });

  const queryClient = useRendererQueryClient();

  useEffect(() => destroyForm, []);

  if (isBuilding) {
    return (
      <p className="p-6 text-sm text-slate-500 dark:text-slate-400">
        Building form…
      </p>
    );
  }

  return (
    <RendererThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BaseRenderer />
      </QueryClientProvider>
    </RendererThemeProvider>
  );
}
