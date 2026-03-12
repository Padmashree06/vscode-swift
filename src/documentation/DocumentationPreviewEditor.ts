//===----------------------------------------------------------------------===//
//
// This source file is part of the VS Code Swift open source project
//
// Copyright (c) 2024-2025 the VS Code Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VS Code Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { LSPErrorCodes, ResponseError } from "vscode-languageclient";

import { WorkspaceContext } from "../WorkspaceContext";
import { DocCDocumentationRequest, DocCDocumentationResponse } from "../sourcekit-lsp/extensions";
import { RenderNode, WebviewContent, WebviewMessage } from "./webview/WebviewMessage";

// eslint-disable-next-line @typescript-eslint/no-require-imports
import throttle = require("lodash.throttle");

export enum PreviewEditorConstant {
    VIEW_TYPE = "swift.previewDocumentationEditor",
    TITLE = "Preview Swift Documentation",
    UNSUPPORTED_EDITOR_ERROR_MESSAGE = "The active text editor does not support Swift Documentation Live Preview",
}

interface SymbolLocation {
    uri: string;
    range: vscode.Range;
}

export class DocumentationPreviewEditor implements vscode.Disposable {
    static async create(
        extension: vscode.ExtensionContext,
        context: WorkspaceContext
    ): Promise<DocumentationPreviewEditor> {
        const swiftDoccRenderPath = extension.asAbsolutePath(
            path.join("assets", "swift-docc-render")
        );
        const webviewPanel = vscode.window.createWebviewPanel(
            PreviewEditorConstant.VIEW_TYPE,
            PreviewEditorConstant.TITLE,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.file(
                        extension.asAbsolutePath(
                            path.join("node_modules", "@vscode/codicons", "dist")
                        )
                    ),
                    vscode.Uri.file(
                        extension.asAbsolutePath(path.join("assets", "documentation-webview"))
                    ),
                    vscode.Uri.file(swiftDoccRenderPath),
                    ...context.folders.map(f => f.folder),
                ],
            }
        );
        webviewPanel.iconPath = {
            light: vscode.Uri.file(
                extension.asAbsolutePath(
                    path.join("assets", "icons", "light", "swift-documentation.svg")
                )
            ),
            dark: vscode.Uri.file(
                extension.asAbsolutePath(
                    path.join("assets", "icons", "dark", "swift-documentation.svg")
                )
            ),
        };
        const webviewBaseURI = webviewPanel.webview.asWebviewUri(
            vscode.Uri.file(swiftDoccRenderPath)
        );
        const scriptURI = webviewPanel.webview.asWebviewUri(
            vscode.Uri.file(
                extension.asAbsolutePath(path.join("assets", "documentation-webview", "index.js"))
            )
        );
        let doccRenderHTML = await fs.readFile(
            path.join(swiftDoccRenderPath, "index.html"),
            "utf-8"
        );
        const codiconsUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.file(
                extension.asAbsolutePath(
                    path.join("node_modules", "@vscode/codicons", "dist", "codicon.css")
                )
            )
        );
        doccRenderHTML = doccRenderHTML
            .replaceAll("{{BASE_PATH}}", webviewBaseURI.toString())
            .replace("</head>", `<link href="${codiconsUri}" rel="stylesheet" /></head>`)
            .replace("</body>", `<script src="${scriptURI.toString()}"></script></body>`);
        webviewPanel.webview.html = doccRenderHTML;

        const editor = new DocumentationPreviewEditor(context, webviewPanel);
        return editor;
    }
    public static readonly instance: DocumentationPreviewEditor;
    private activeTextEditor?: vscode.TextEditor;
    private activeTextEditorSelection?: vscode.Selection;
    private subscriptions: vscode.Disposable[] = [];
    private isDisposed: boolean = false;
    private disposeEmitter = new vscode.EventEmitter<void>();
    private renderEmitter = new vscode.EventEmitter<void>();
    private updateContentEmitter = new vscode.EventEmitter<WebviewContent>();
    public symbolUriMap = new Map<string, SymbolLocation>();
    private symbolReferenceMap = new Map<string, vscode.Location[]>();
    private constructor(
        private readonly context: WorkspaceContext,
        private readonly webviewPanel: vscode.WebviewPanel
    ) {
        this.activeTextEditor = vscode.window.activeTextEditor;
        this.subscriptions.push(
            this.webviewPanel.webview.onDidReceiveMessage(this.receiveMessage, this),
            vscode.window.onDidChangeActiveTextEditor(this.handleActiveTextEditorChange, this),
            vscode.window.onDidChangeTextEditorSelection(this.handleSelectionChange, this),
            vscode.workspace.onDidChangeTextDocument(this.handleDocumentChange, this),
            this.webviewPanel.onDidDispose(this.dispose, this)
        );
        this.reveal();
    }

    /** An event that is fired when the Documentation Preview Editor is disposed */
    onDidDispose = this.disposeEmitter.event;

    /** An event that is fired when the Documentation Preview Editor updates its content */
    onDidUpdateContent = this.updateContentEmitter.event;

    /** An event that is fired when the Documentation Preview Editor renders its content */
    onDidRenderContent = this.renderEmitter.event;

    reveal() {
        // Reveal the editor, but don't change the focus of the active text editor
        this.webviewPanel.reveal(undefined, true);
    }

    dispose() {
        this.isDisposed = true;
        this.subscriptions.forEach(subscription => subscription.dispose());
        this.subscriptions = [];
        this.webviewPanel.dispose();
        this.disposeEmitter.fire();
    }

    private postMessage(message: WebviewMessage) {
        if (this.isDisposed) {
            return;
        }
        if (message.type === "update-content") {
            this.updateContentEmitter.fire(message.content);
        }
        void this.webviewPanel.webview.postMessage(message);
    }

    private receiveMessage(message: WebviewMessage) {
        switch (message.type) {
            case "loaded":
                if (!this.activeTextEditor) {
                    break;
                }
                void this.convertDocumentation(this.activeTextEditor);
                break;
            case "rendered":
                this.renderEmitter.fire();
                break;
            case "openSymbol":
                void this.openSymbol(message.uri);
                break;
        }
    }

    private handleActiveTextEditorChange(activeTextEditor: vscode.TextEditor | undefined) {
        if (this.activeTextEditor === activeTextEditor || activeTextEditor === undefined) {
            return;
        }
        this.activeTextEditor = activeTextEditor;
        this.activeTextEditorSelection = activeTextEditor.selection;
        void this.convertDocumentation(activeTextEditor);
    }

    private handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent) {
        if (
            this.activeTextEditor !== event.textEditor ||
            this.activeTextEditorSelection === event.textEditor.selection
        ) {
            return;
        }
        this.activeTextEditorSelection = event.textEditor.selection;
        void this.convertDocumentation(event.textEditor);
    }

    private handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
        if (this.activeTextEditor?.document === event.document) {
            void this.convertDocumentation(this.activeTextEditor);
        }
    }
    private convertDocumentation = throttle(
        async (textEditor: vscode.TextEditor): Promise<void> => {
            const document = textEditor.document;
            if (
                document.uri.scheme !== "file" ||
                !["markdown", "tutorial", "swift"].includes(document.languageId)
            ) {
                this.postMessage({
                    type: "update-content",
                    content: {
                        type: "error",
                        errorMessage: PreviewEditorConstant.UNSUPPORTED_EDITOR_ERROR_MESSAGE,
                    },
                });
                return;
            }

            const folderContext = this.context.folders.find(folderContext =>
                document.uri.fsPath.startsWith(folderContext.folder.fsPath)
            );

            if (!folderContext) {
                return;
            }
            const text = document.getText();

            this.symbolReferenceMap.clear();
            this.symbolUriMap.clear();

            const symbolLinkRegrex = /``([^`]+)``/g;
            let match: RegExpMatchArray | null;
            while ((match = symbolLinkRegrex.exec(text)) !== null) {
                const symbolName = match[1];
                const position = document.positionAt(match.index!);
                const range = new vscode.Range(position, position);

                const location = new vscode.Location(document.uri, range);

                const existing = this.symbolReferenceMap.get(symbolName) || [];
                existing.push(location);
                this.symbolReferenceMap.set(symbolName, existing);
                await this.storeSymbolInformation(symbolName);
            }

            const languageClientManager = this.context.languageClientManager.get(folderContext);
            try {
                const response = await languageClientManager.useLanguageClient(
                    async (client): Promise<DocCDocumentationResponse> => {
                        return await client.sendRequest(DocCDocumentationRequest.type, {
                            textDocument: {
                                uri: document.uri.toString(),
                            },
                            position: textEditor.selection.start,
                        });
                    }
                );
                this.postMessage({
                    type: "update-content",
                    content: {
                        type: "render-node",
                        renderNode: this.parseRenderNode(response.renderNode),
                    },
                });
            } catch (error) {
                // Update the preview editor to reflect what error occurred
                let livePreviewErrorMessage = "An internal error occurred";
                const baseLogErrorMessage = `SourceKit-LSP request "${DocCDocumentationRequest.method}" failed: `;
                if (error instanceof ResponseError) {
                    if (error.code === LSPErrorCodes.RequestCancelled) {
                        // We can safely ignore cancellations
                        return undefined;
                    }
                    if (error.code === LSPErrorCodes.RequestFailed) {
                        // RequestFailed response errors can be shown to the user
                        livePreviewErrorMessage = error.message;
                    } else {
                        // We should log additional info for other response errors
                        this.context.logger.error(
                            baseLogErrorMessage + JSON.stringify(error.toJson(), undefined, 2)
                        );
                    }
                } else {
                    this.context.logger.error(baseLogErrorMessage + `${error}`);
                }
                this.postMessage({
                    type: "update-content",
                    content: {
                        type: "error",
                        errorMessage: livePreviewErrorMessage,
                    },
                });
            }
        },
        100 /* 10 times per second */,
        { trailing: true }
    );

    private async openSymbol(symbolKey: string) {
        if (symbolKey.startsWith("https://")) {
            await this.handleWebLink(symbolKey);
            return;
        }

        const cleanKey = symbolKey.replace(/^\//, "");
        const value = this.symbolUriMap.get(cleanKey);

        if (!value) {
            const refs = this.symbolReferenceMap.get(cleanKey);

            if (refs && refs.length > 0) {
                const ref = refs[0];

                const line = ref.range.start.line + 1;
                const col = ref.range.start.character + 1;

                const terminal =
                    vscode.window.activeTerminal || vscode.window.createTerminal("Extension Log");
                terminal.show(true);
                terminal.sendText(
                    `Symbol '${cleanKey}' not found.\nReferenced at line ${line}, column ${col} in ${ref.uri}`
                );

                void vscode.window.showInformationMessage(
                    `Symbol "${cleanKey}" not found.\nReferenced at line ${line}, column ${col} in ${ref.uri}`
                );

                await this.openAndReveal(ref.uri, ref.range.start);
            }

            return;
        }

        const uri = vscode.Uri.parse(value.uri);
        const position = new vscode.Position(value.range.start.line, value.range.start.character);

        await this.openAndReveal(uri, position);
    }
    private async openAndReveal(uri: vscode.Uri, position: vscode.Position) {
        const alreadyOpenEditor = vscode.window.visibleTextEditors.find(
            editor => editor.document.uri.toString() === uri.toString()
        );

        let editor: vscode.TextEditor;

        if (alreadyOpenEditor) {
            editor = alreadyOpenEditor;
            await vscode.window.showTextDocument(editor.document, {
                viewColumn: editor.viewColumn,
                preview: false,
            });
        } else {
            const activeEditor = vscode.window.activeTextEditor;
            const targetColumn = activeEditor?.viewColumn ?? vscode.ViewColumn.One;

            const doc = await vscode.workspace.openTextDocument(uri);
            editor = await vscode.window.showTextDocument(doc, {
                viewColumn: targetColumn,
                preview: false,
            });
        }

        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    }

    private async storeSymbolInformation(symbolName: string) {
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            "vscode.executeWorkspaceSymbolProvider",
            symbolName
        );

        if (!symbols || symbols.length === 0) {
            return;
        }

        const match = symbols.find(s => s.name === symbolName);

        if (match) {
            this.symbolUriMap.set(symbolName, {
                uri: match.location.uri.toString(),
                range: match.location.range,
            });
        }
    }

    private async handleWebLink(url: string) {
        const terminal =
            vscode.window.activeTerminal || vscode.window.createTerminal("Extension Log");

        try {
            const response = await fetch(url, { method: "HEAD" });

            if (!response.ok) {
                void vscode.window.showErrorMessage(`Link doe not exist: ${url}`);
                terminal.show(true);
                terminal.sendText(`Link does not exist: ${url}`);

                return;
            }

            await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (err) {
            terminal.show(true);
            terminal.sendText(`Unable to reach link: ${url}`);
            void vscode.window.showErrorMessage(`Unable to reach link: ${url}`);
        }
    }

    private parseRenderNode(content: string): RenderNode {
        const renderNode: RenderNode = JSON.parse(content);
        for (const referenceKey of Object.getOwnPropertyNames(renderNode.references)) {
            const reference = renderNode.references[referenceKey];
            for (const variant of reference.variants ?? []) {
                const uri = vscode.Uri.parse(variant.url).with({ scheme: "file" });
                variant.url = this.webviewPanel.webview.asWebviewUri(uri).toString();
            }
        }
        return renderNode;
    }
}
