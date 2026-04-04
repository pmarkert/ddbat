export type DdbatItem = Record<string, unknown>;

export type TransformResult<TOutput extends DdbatItem = DdbatItem> =
  | TOutput
  | TOutput[]
  | undefined
  | null;

export type TransformFn<
  TInput extends DdbatItem = DdbatItem,
  TOutput extends DdbatItem = TInput,
> = (item: TInput, index: number) => TransformResult<TOutput> | Promise<TransformResult<TOutput>>;
