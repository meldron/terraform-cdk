import { CodeMaker } from "codemaker";
import { Provider, ProviderSchema } from "./provider-schema";
import { ResourceModel } from "./models";
import { ResourceParser } from "./resource-parser";
import { ResourceEmitter, StructEmitter } from "./emitter";
import { ConstructsMakerTarget } from "../constructs-maker";
import * as path from "path";
import { logger } from "../../config";
interface ProviderData {
  name: string;
  source: string;
  version: string;
}

const isMatching = (
  target: ConstructsMakerTarget,
  terraformSchemaName: string
): boolean => {
  if (target.isModule) return false;

  const elements = terraformSchemaName.split("/");

  if (elements.length === 1) {
    return target.source === terraformSchemaName;
  } else {
    const [hostname, scope, provider] = elements;

    if (!hostname || !scope || !provider) {
      throw new Error(`can't handle ${terraformSchemaName}`);
    }

    return target.name === provider;
  }
};

export interface ProviderConstraints {
  [fqn: string]: ProviderData;
}

export class TerraformProviderGenerator {
  private resourceParser = new ResourceParser();
  private resourceEmitter: ResourceEmitter;
  private structEmitter: StructEmitter;
  public versions: { [fqpn: string]: string | undefined } = {};
  constructor(
    private readonly code: CodeMaker,
    schema: ProviderSchema,
    private providerConstraints?: ConstructsMakerTarget
  ) {
    this.code.indentation = 2;
    this.resourceEmitter = new ResourceEmitter(this.code);
    this.structEmitter = new StructEmitter(this.code);

    if (!schema.provider_schemas) {
      logger.info("no providers - nothing to do");
      return;
    }

    const versions: { [fqpn: string]: string | undefined } = {};
    for (const [fqpn, provider] of Object.entries(schema.provider_schemas)) {
      const providerVersion = schema.provider_versions
        ? schema.provider_versions[fqpn]
        : undefined;

      if (
        (this.providerConstraints &&
          isMatching(this.providerConstraints, fqpn)) ||
        !this.providerConstraints
      ) {
        this.emitProvider(fqpn, provider, providerVersion);
        versions[fqpn] = providerVersion;
      }
    }
    this.versions = versions;
  }

  public async save(outdir: string) {
    await this.code.save(outdir);
  }

  private emitProvider(
    fqpn: string,
    provider: Provider,
    providerVersion?: string
  ) {
    const name = fqpn.split("/").pop();
    if (!name) {
      throw new Error(`can't handle ${fqpn}`);
    }

    let constraint: ConstructsMakerTarget | undefined;
    if (this.providerConstraints) {
      if (!isMatching(this.providerConstraints, fqpn)) {
        throw new Error(`can't handle ${fqpn}`);
      }
      constraint = this.providerConstraints;
    }

    const resourceModels: ResourceModel[] = [];
    for (const [type, resource] of Object.entries(
      provider.resource_schemas || []
    )) {
      resourceModels.push(
        this.resourceParser.parse(name, type, resource, "resource")
      );
    }
    for (const [type, resource] of Object.entries(
      provider.data_source_schemas || []
    )) {
      resourceModels.push(
        this.resourceParser.parse(name, `data_${type}`, resource, "data_source")
      );
    }

    type NamespaceName = string;
    const namespacedResources: Record<NamespaceName, ResourceModel[]> = {};
    const files: string[] = [];
    resourceModels.forEach((resourceModel) => {
      if (constraint) {
        resourceModel.providerVersionConstraint = constraint.version;
        resourceModel.terraformProviderSource = constraint.source;
      }
      resourceModel.providerVersion = providerVersion;

      if (resourceModel.namespace) {
        const namespace = resourceModel.namespace.name;
        if (!namespacedResources[namespace]) {
          namespacedResources[namespace] = [];
        }
        namespacedResources[namespace].push(resourceModel);
      } else if (resourceModel.structsRequireSharding) {
        files.push(this.emitResourceFileWithComplexStruct(resourceModel));
      } else {
        files.push(this.emitResourceFile(resourceModel));
      }
    });

    for (const [, resources] of Object.entries(namespacedResources)) {
      files.push(this.emitNamespacedResourceFile(name, resources));
    }

    if (provider.provider) {
      const providerResource = this.resourceParser.parse(
        name,
        `provider`,
        provider.provider,
        "provider"
      );
      if (constraint) {
        providerResource.providerVersionConstraint = constraint.version;
        providerResource.terraformProviderSource = constraint.source;
      }
      providerResource.providerVersion = providerVersion;
      files.push(this.emitResourceFile(providerResource));
    }

    this.emitIndexFile(name, files);
  }

  private emitIndexFile(provider: string, files: string[]): void {
    const folder = `providers/${provider}`;
    const filePath = `${folder}/index.ts`;
    this.code.openFile(filePath);
    this.code.line("// generated by cdktf get");
    for (const file of files) {
      if (file.startsWith("ns:")) {
        const fileName = file.replace("ns:", "");
        this.code.line(`export * as ${fileName} from './${fileName}'`);
      } else {
        this.code.line(
          `export * from './${file
            .replace(`${folder}/`, "")
            .replace(".ts", "")}';`
        );
      }
    }
    this.code.line();
    this.code.closeFile(filePath);
  }

  private emitResourceFile(resource: ResourceModel): string {
    this.code.openFile(resource.filePath);
    this.emitFileHeader(resource);
    this.structEmitter.emit(resource);
    this.resourceEmitter.emit(resource);
    this.code.closeFile(resource.filePath);

    return resource.filePath;
  }

  private emitNamespacedResourceFile(
    providerName: string,
    resources: ResourceModel[]
  ) {
    const ns = resources[0].namespace;
    const comment = ns?.comment;

    if (!ns?.name) throw new Error("namespace name is missing");

    const generatedFiles = [];
    for (const resource of resources) {
      // drop the last segment of the filepath
      const filePath = resource.filePath.split("/").slice(0, -1).join("/");
      const namespacedFilePath = path.join(
        filePath,
        ns.name,
        resource.fileName
      );
      this.code.openFile(namespacedFilePath);
      this.code.line(`// generated from terraform resource schema`);
      this.code.line();

      if (resource.structsRequireSharding) {
        this.code.line(
          `import { ${resource.referencedTypes.join(", \n")}} from './${
            resource.structsFolderName
          }'`
        );

        resource.importStatements.forEach((statement) =>
          this.code.line(statement)
        );
        this.code.line();
        this.code.line(`/**`);
        this.code.line(`* ${comment}`);
        this.code.line(`*/`);

        this.structEmitter.emitInterface(resource, resource.configStruct);
        this.resourceEmitter.emit(resource);

        this.code.closeFile(namespacedFilePath);

        this.structEmitter.emit(resource);
        generatedFiles.push(resource.fileName);
        generatedFiles.push(resource.structsFolderName);
      } else {
        resource.importStatements.forEach((statement) =>
          this.code.line(statement)
        );
        this.code.line();
        this.code.line(`/**`);
        this.code.line(`* ${comment}`);
        this.code.line(`*/`);

        this.structEmitter.emit(resource);
        this.resourceEmitter.emit(resource);
        this.code.closeFile(namespacedFilePath);
        generatedFiles.push(resource.fileName);
      }
    }

    const indexFilePath = path.join(
      `providers`,
      providerName,
      ns.name,
      "index.ts"
    );
    this.code.openFile(indexFilePath);
    this.code.line("// generated by cdktf get");
    for (const file of generatedFiles) {
      this.code.line(`export * from './${path.basename(file, ".ts")}';`);
    }
    this.code.line();
    this.code.closeFile(indexFilePath);

    return `ns:${ns.name}`;
  }

  private emitResourceFileWithComplexStruct(resource: ResourceModel) {
    const generatedFiles = [];

    // drop the last segment of the filepath
    const filePath = resource.filePath;
    this.code.openFile(filePath);
    this.code.line(`// generated from terraform resource schema`);
    this.code.line();

    if (resource.structsRequireSharding) {
      if (resource.referencedTypes.length > 0) {
        this.code.line(
          `import { ${resource.referencedTypes.join(", \n")}} from './${
            resource.structsFolderName
          }'`
        );
      }

      this.code.line(`export * from './${resource.structsFolderName}'`);

      resource.importStatements.forEach((statement) =>
        this.code.line(statement)
      );

      this.structEmitter.emitInterface(resource, resource.configStruct);
      this.resourceEmitter.emit(resource);

      this.code.closeFile(filePath);

      this.structEmitter.emit(resource);
      generatedFiles.push(resource.fileName);
      generatedFiles.push(resource.structsFolderName);
    } else {
      resource.importStatements.forEach((statement) =>
        this.code.line(statement)
      );

      this.structEmitter.emit(resource);
      this.resourceEmitter.emit(resource);
      this.code.closeFile(filePath);
      generatedFiles.push(resource.fileName);
    }

    return filePath;
  }

  private emitFileHeader(resource: ResourceModel) {
    this.code.line(`// ${resource.linkToDocs}`);
    this.code.line(`// generated from terraform resource schema`);
    this.code.line();
    resource.importStatements.forEach((statement) => this.code.line(statement));
    this.code.line();
    this.code.line("// Configuration");
    this.code.line();
  }
}
