import * as vscode from "vscode"
import { DocumentationPreviewEditor } from "../../documentation/DocumentationPreviewEditor"

class DoccDefinitionProvider implements vscode.DefinitionProvider {

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Definition | undefined {
        const line = document.lineAt(position.line).text;

        const regex = /``([^`]+)``/g;
        let match;

        while ((match = regex.exec(line)) !== null) {

            const start = match.index;
            const end = start + match[0].length;

            if (position.character >= start && position.character <= end) {

                const symbol = match[1];

                const map = DocumentationPreviewEditor.instance.symbolUriMap;
                const value = map.get(symbol);

                if (!value){ 
                    return;
                }
                return new vscode.Location(
                    vscode.Uri.parse(value.uri),
                    value.range
                );
            }
        }
    }
}
export function registerDocCDefinitionProvider(
): vscode.Disposable {

    return vscode.languages.registerDefinitionProvider(
        ["swift", "markdown", "tutorial"],
        new DoccDefinitionProvider()
    );
}