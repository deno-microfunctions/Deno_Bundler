import { colors, ImportMap, path, Sha256, ts } from "../../deps.ts";
import {
  ChunkList,
  Context,
  Dependencies,
  DependencyType,
  Format,
  Item,
  Plugin,
} from "../plugin.ts";
import { resolve as resolveDependency } from "../../dependency.ts";
import { typescriptExtractDependenciesTransformer } from "./transformers/extract_dependencies.ts";
import { cache, resolve as resolveCache } from "../../cache.ts";
import { getAsset } from "../../graph.ts";
import { isURL, readTextFile, timestamp } from "../../_util.ts";

function resolveDependencies(
  filePath: string,
  { imports, exports }: Dependencies,
  { importMap = { imports: {} } }: { importMap: ImportMap },
) {
  const dependencies: Dependencies = {
    imports: {},
    exports: {},
  };

  Object.keys(imports).forEach((dependencyPath) => {
    const resolvedDependencyPath = resolveDependency(
      filePath,
      dependencyPath,
      importMap,
    );
    dependencies.imports[resolvedDependencyPath] = imports[dependencyPath];
  });
  Object.keys(exports).forEach((dependencyPath) => {
    const resolvedDependencyPath = resolveDependency(
      filePath,
      dependencyPath,
      importMap,
    );
    dependencies.exports[resolvedDependencyPath] = exports[dependencyPath];
  });

  return dependencies;
}

export class TypescriptPlugin extends Plugin {
  compilerOptions: ts.CompilerOptions;
  constructor(
    {
      compilerOptions = {},
    }: {
      compilerOptions?: ts.CompilerOptions;
    } = {},
  ) {
    super();
    this.compilerOptions = compilerOptions;
  }
  async test(item: Item, context: Context) {
    const input = item.history[0];
    return /\.(t|j)sx?$/.test(input) ||
      (isURL(input) &&
        !/([\.][a-zA-Z]\w*)$/.test(
          input,
        )); /* is handle url without extension as script */
  }
  async readSource(input: string, context: Context) {
    let filePath = input;
    if (isURL(filePath)) {
      await cache(filePath);
      filePath = resolveCache(filePath);
    }
    const source = await readTextFile(filePath);
    const sourceFile = ts.createSourceFile(
      input,
      source,
      ts.ScriptTarget.Latest,
    );
    return sourceFile;
  }
  async createAsset(
    item: Item,
    context: Context,
  ) {
    const input = item.history[0];

    const { bundler, outputMap, depsDirPath, importMap } = context;
    const sourceFile = await bundler.readSource(item, context) as ts.SourceFile;
    const dependencies: Dependencies = { imports: {}, exports: {} };
    const t2 = performance.now();
    ts.transform(
      sourceFile,
      [typescriptExtractDependenciesTransformer(dependencies)],
      this.compilerOptions,
    );
    context.bundler.logger.trace(
      "Extract Dependencies",
      input,
      colors.dim(colors.italic(`(${timestamp(t2)})`)),
    );
    const t3 = performance.now();
    const resolvedDependencies = resolveDependencies(
      input,
      dependencies,
      { importMap },
    );
    context.bundler.logger.trace(
      "Resolve Dependencies",
      input,
      colors.dim(colors.italic(`(${timestamp(t3)})`)),
    );

    const extension = ".js";
    return {
      filePath: input,
      output: outputMap[input] || path.join(
        depsDirPath,
        `${new Sha256().update(input).hex()}${extension}`,
      ),
      dependencies: resolvedDependencies,
      format: Format.Script,
    };
  }
  async createChunk(
    item: Item,
    context: Context,
    chunkList: ChunkList,
  ) {
    const dependencyItems: Item[] = [];
    const { history, type } = item;
    const chunkInput = history[0];
    const asset = getAsset(context.graph, chunkInput, type);

    const dependencies = [
      ...Object.entries(asset.dependencies.imports),
      ...Object.entries(asset.dependencies.exports),
    ];
    for (const [input, dependency] of dependencies) {
      if (input === chunkInput) continue;
      const { type, format } = dependency;
      const newItem: Item = {
        history: [input, ...item.history],
        type,
        format,
      };
      switch (format) {
        case Format.Script: {
          switch (type) {
            case DependencyType.Import:
            case DependencyType.Export:
              dependencyItems.push(newItem);
              break;
            case DependencyType.DynamicImport:
            case DependencyType.ServiceWorker:
            case DependencyType.WebWorker:
            case DependencyType.Import:
              chunkList.push(newItem);
              break;
          }
          break;
        }
        case Format.Json: {
          switch (type) {
            case DependencyType.Import: {
              dependencyItems.push(newItem);
              break;
            }
            default: {
              chunkList.push(newItem);
              break;
            }
          }
          break;
        }
        case Format.Style: {
          switch (type) {
            case DependencyType.Import: {
              dependencyItems.push(newItem);
              break;
            }
            default: {
              chunkList.push(newItem);
              break;
            }
          }
          break;
        }
        default: {
          chunkList.push(newItem);
          break;
        }
      }
    }
    return {
      item,
      dependencyItems,
    };
  }
}
