/** Server action → form arasındaki ortak sonuç tipi (useActionState ile kullanılır). */
export interface ActionState {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
}

export const initialActionState: ActionState = {};
