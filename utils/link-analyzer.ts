import { TFile, TFolder, Vault } from 'obsidian';

/**
 * Represents a link to another note
 */
export interface NoteLink {
    /**
     * The text content of the link
     */
    text: string;
    
    /**
     * Whether this is an embed link (![[...]]) or a regular link ([[...]])
     */
    isEmbed: boolean;
}

/**
 * Represents a node in the file link graph
 */
export interface FileNode {
    /**
     * Path to the file
     */
    path: string;
    
    /**
     * File content
     */
    content?: string;
    
    /**
     * Outgoing links (files this file links to)
     */
    outgoingLinks: string[];
    
    /**
     * Regular (non-embed) outgoing links
     */
    regularLinks: string[];
    
    /**
     * Embed outgoing links
     */
    embedLinks: string[];
    
    /**
     * Incoming links (files that link to this file)
     */
    incomingLinks: string[];
    
    /**
     * Count of incoming links (used for ranking)
     */
    incomingLinkCount: number;
}

/**
 * Represents a review hierarchy for a group of files
 */
export interface ReviewHierarchy {
    /**
     * Root nodes in the hierarchy (starting points)
     */
    rootNodes: string[];
    
    /**
     * All nodes in the hierarchy
     */
    nodes: Record<string, FileNode>;
    
    /**
     * Traversal order for review
     */
    traversalOrder: string[];
}

/**
 * Utility class for analyzing links between files
 */
export class LinkAnalyzer {
    /**
     * Regular expression for finding wikilinks of both forms: [[filename]] and ![[filename]]
     * First capture group matches the exclamation mark (if present)
     * Second capture group matches the content inside the brackets
     */
    private static readonly LINK_REGEX = /(!?)(?:\[\[(.*?)\]\])/g;
    
    /**
     * Analyze links in a folder and build a review hierarchy
     * 
     * @param vault Obsidian vault
     * @param folder Folder to analyze
     * @param includeSubfolders Whether to include subfolders
     * @returns Review hierarchy for the folder
     */
    static async analyzeFolder(
        vault: Vault, 
        folder: TFolder, 
        includeSubfolders: boolean
    ): Promise<ReviewHierarchy> {
        // Get all markdown files in the folder
        const files = vault.getMarkdownFiles().filter(file => {
            if (includeSubfolders) {
                return file.path.startsWith(folder.path);
            } else {
                const parentPath = file.parent ? file.parent.path : "";
                return parentPath === folder.path;
            }
        });
        
        // Initialize nodes
        const nodes: Record<string, FileNode> = {};
        for (const file of files) {
            nodes[file.path] = {
                path: file.path,
                outgoingLinks: [],
                regularLinks: [],
                embedLinks: [],
                incomingLinks: [],
                incomingLinkCount: 0
            };
        }
        
        // Read file contents and extract links, preserving order
        for (const file of files) {
            try {
                const content = await vault.read(file);
                const node = nodes[file.path];
                node.content = content;
                
                // Extract links in the order they appear
                const noteLinks = this.extractLinks(content);
                
                // Process each link in order
                for (const noteLink of noteLinks) {
                    // Try to resolve the link to a full path
                    const resolvedPath = this.resolveLink(noteLink.text, file.path, files);
                    if (resolvedPath && nodes[resolvedPath]) {
                        // Add to appropriate outgoing links arrays
                        if (!node.outgoingLinks.includes(resolvedPath)) {
                            node.outgoingLinks.push(resolvedPath);
                            
                            // Also add to the appropriate type-specific array
                            if (noteLink.isEmbed) {
                                if (!node.embedLinks.includes(resolvedPath)) {
                                    node.embedLinks.push(resolvedPath);
                                }
                            } else {
                                if (!node.regularLinks.includes(resolvedPath)) {
                                    node.regularLinks.push(resolvedPath);
                                }
                            }
                        }
                        
                        // Update incoming links for the target
                        const targetNode = nodes[resolvedPath];
                        if (!targetNode.incomingLinks.includes(file.path)) {
                            targetNode.incomingLinks.push(file.path);
                            targetNode.incomingLinkCount++;
                        }
                    }
                }
            } catch (error) { /* handle error */ }
        }
        
        // Find the node with the most outgoing links as the starting point
        const startingNode = this.findStartingNode(nodes);
        
        // Create traversal order that respects the order of links
        const traversalOrder = this.createTraversalOrder(nodes, startingNode);
        
        return {
            rootNodes: startingNode,
            nodes,
            traversalOrder
        };
    }
    
    /**
     * Extract links from markdown content in the order they appear
     * 
     * @param content Markdown content
     * @returns Array of note links with information about whether they are embeds
     */
    static extractLinks(content: string): NoteLink[] {
        const links: NoteLink[] = [];
        let match;
        
        // Reset regex lastIndex to ensure we start from the beginning
        this.LINK_REGEX.lastIndex = 0;
        
        // Find all [[...]] or ![[...]] links in order
        while ((match = this.LINK_REGEX.exec(content)) !== null) {
            links.push({
                text: match[2], // The link text is now in the second capture group
                isEmbed: match[1] === '!' // True if it has an exclamation mark
            });
        }
        
        return links;
    }
    
    /**
     * Resolve a link to a full file path
     * 
     * @param link Link text
     * @param sourcePath Path of the source file
     * @param allFiles All available files
     * @returns Resolved file path or null if not found
     */
    static resolveLink(link: string, sourcePath: string, allFiles: TFile[]): string | null {
        // Handle links with .md extension explicitly
        if (link.endsWith('.md')) {
            // Try to find the exact file
            const exactFile = allFiles.find(f => f.path.endsWith('/' + link) || f.path === link);
            if (exactFile) {
                return exactFile.path;
            }
        }
        
        // Try to find by basename (without extension)
        const basename = link.split('/').pop();
        if (!basename) return null;
        
        // Look for files with matching basename
        const matchingFiles = allFiles.filter(f => f.basename === basename);
        
        if (matchingFiles.length === 0) {
            return null;
        }
        
        if (matchingFiles.length === 1) {
            return matchingFiles[0].path;
        }
        
        // If multiple matches, try to find the one in the same folder
        const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf('/'));
        const sameDir = matchingFiles.find(f => f.path.startsWith(sourceDir + '/'));
        
        return sameDir ? sameDir.path : matchingFiles[0].path;
    }
    
    /**
     * Find the best starting node based on file naming and link structure
     * 
     * @param nodes All file nodes
     * @returns Array with the path of the best starting node
     */
    private static findStartingNode(nodes: Record<string, FileNode>): string[] {
        // If we have no nodes, return an empty array
        if (Object.keys(nodes).length === 0) {
            return [];
        }
        
        // Organize nodes into a folder structure for better matching
        const folderNodes: Record<string, string[]> = {};
        
        for (const path in nodes) {
            const folderPath = path.substring(0, path.lastIndexOf('/'));
            if (!folderNodes[folderPath]) {
                folderNodes[folderPath] = [];
            }
            folderNodes[folderPath].push(path);
        }
        
        // For each folder, look for the best starting node
        for (const folderPath in folderNodes) {
            const folderName = folderPath.split('/').pop()?.toLowerCase() || '';
            const filesInFolder = folderNodes[folderPath];
            
            // HIGHEST PRIORITY: Exact match with folder name
            for (const path of filesInFolder) {
                const fileName = path.split('/').pop()?.toLowerCase().replace(/\.md$/, '') || '';
                if (fileName === folderName) {
                    return [path];
                }
            }

            // SECOND PRIORITY: Partial match with folder name
            for (const path of filesInFolder) {
                const fileName = path.split('/').pop()?.toLowerCase().replace(/\.md$/, '') || '';
                if (fileName.includes(folderName) || folderName.includes(fileName)) {
                    return [path];
                }
            }

            // THIRD PRIORITY: Common index or main file patterns
            for (const path of filesInFolder) {
                const fileName = path.split('/').pop()?.toLowerCase().replace(/\.md$/, '') || '';
                if (fileName === 'index' || fileName === 'main' || fileName.includes('index') || fileName.includes('readme') || fileName.includes('main')) {
                    return [path];
                }
            }
        }
        
        // FOURTH PRIORITY: Look for files with the most outgoing links
        // Prefer regular links over embeds
        const sortedNodes = Object.values(nodes)
            .sort((a, b) => {
                // First, prioritize by regular link count (non-embed links)
                const regularLinkDiff = b.regularLinks.length - a.regularLinks.length;
                if (regularLinkDiff !== 0) {
                    return regularLinkDiff;
                }
                
                // If they have the same number of regular links, check total outgoing links
                return b.outgoingLinks.length - a.outgoingLinks.length;
            });
        
        if (sortedNodes.length > 0 && 
            (sortedNodes[0].regularLinks.length > 0 || sortedNodes[0].outgoingLinks.length > 0)) {
            // Return the node with the most links
            return [sortedNodes[0].path];
        }
        
        // FALLBACK: Use all files as root nodes if none of the above criteria match
        return Object.keys(nodes).length > 0 ? [Object.keys(nodes)[0]] : [];
    }
    
    /**
     * Find root nodes (files with the most incoming links)
     * For backward compatibility, retained but replaced by findStartingNode
     * 
     * @param nodes All file nodes
     * @returns Array of root node paths
     */
    private static findRootNodes(nodes: Record<string, FileNode>): string[] {
        return this.findStartingNode(nodes);
    }
    
    /**
     * Create a traversal order for reviewing files that respects the exact order of links
     * 
     * @param nodes All file nodes
     * @param startNodePath Path to the starting node
     * @returns Array of file paths in traversal order
     */
    private static createOrderedTraversal(
        nodes: Record<string, FileNode>,
        startNodePath: string
    ): string[] {
        const visited = new Set<string>();
        const traversalOrder: string[] = [];
        
        // Track which folder each file belongs to
        const fileFolders = new Map<string, string>();
        for (const path in nodes) {
            // Extract folder path from file path
            const folderPath = path.substring(0, path.lastIndexOf('/'));
            fileFolders.set(path, folderPath);
        }
        
        const mainFolder = fileFolders.get(startNodePath) || "";

        // Helper function for depth-first traversal, respecting link order and folder constraints
        const traverse = (currentNodePath: string, currentDepth: number = 0, currentMainFolder: string) => {
            if (visited.has(currentNodePath)) {
                return;
            }

            const node = nodes[currentNodePath];
            if (!node) {
                return;
            }
            
            visited.add(currentNodePath);
            traversalOrder.push(currentNodePath);
            
            const currentNodeFolder = fileFolders.get(currentNodePath) || "";
            
            // Prefer regular links over embeds, then all outgoing links if no regular ones
            const linksToFollow = node.regularLinks.length > 0 ? node.regularLinks : node.outgoingLinks;
            
            for (const linkedPath of linksToFollow) {
                if (!nodes[linkedPath]) { // Ensure the linked path is a known node in the current analysis context
                    continue;
                }

                const linkedNodeFolder = fileFolders.get(linkedPath) || "";

                // MODIFIED RULE: Traverse if the linked note is within the scope of the main analysis folder.
                if (nodes[linkedPath] && linkedNodeFolder.startsWith(currentMainFolder)) { // Ensure it's a known node and within the main hierarchy
                    if (!visited.has(linkedPath)) { // Avoid re-traversing already processed branches
                        traverse(linkedPath, currentDepth + 1, currentMainFolder);
                    } else {
                    }
                } else {
                    // This link goes outside the main folder being analyzed or is not a known node.
                }
            }
        };
        
        // Start traversal from the designated startNodePath, if it exists
        if (nodes[startNodePath]) {
            traverse(startNodePath, 0, mainFolder);
        } else {
        }
        
        // The traversal initiated by traverse(startNodePath, 0) should now correctly capture
        // only the linked hierarchy within the same folder. We no longer add all other
        // unlinked files from the mainFolder.
        
        // Log the traversal order summary
        
        return traversalOrder;
    }
    
    /**
     * Create a traversal order for reviewing files
     * 
     * @param nodes All file nodes
     * @param rootNodes Root node paths
     * @returns Array of file paths in traversal order
     */
    private static createTraversalOrder(
        nodes: Record<string, FileNode>,
        rootNodes: string[]
    ): string[] {
        // If there's a single root node, use the ordered traversal
        if (rootNodes.length === 1) {
            return this.createOrderedTraversal(nodes, rootNodes[0]);
        }
        
        // Otherwise use the original implementation for multiple root nodes
        const visited = new Set<string>();
        const traversalOrder: string[] = [];
        
        // Helper function for depth-first traversal
        const traverse = (nodePath: string) => {
            if (visited.has(nodePath)) return;
            
            visited.add(nodePath);
            traversalOrder.push(nodePath);
            
            const node = nodes[nodePath];
            if (!node) return;
            
            // Traverse outgoing links depth-first
            for (const linkedPath of node.outgoingLinks) {
                traverse(linkedPath);
            }
        };
        
        // Start traversal from each root node
        for (const rootPath of rootNodes) {
            traverse(rootPath);
        }
        
        // Add any remaining unvisited nodes
        for (const nodePath of Object.keys(nodes)) {
            if (!visited.has(nodePath)) {
                traversalOrder.push(nodePath);
                visited.add(nodePath);
            }
        }
        
        return traversalOrder;
    }
    
    /**
     * Analyze links in a single note
     * 
     * @param vault Obsidian vault
     * @param filePath Path to the note file
     * @param regularOnly Whether to include only regular wiki links (not embeds)
     * @returns Array of resolved link paths in the order they appear
     */
    static async analyzeNoteLinks(
        vault: Vault, 
        filePath: string, 
        regularOnly: boolean = false
    ): Promise<string[]> {
        const file = vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            return [];
        }
        
        try {
            const content = await vault.read(file);
            const noteLinks = this.extractLinks(content);
            const resolvedLinks: string[] = [];
            
            // Maintain a record of links that appear multiple times
            // We'll only include the first occurrence in our results
            const seenLinks = new Set<string>();
            
            // Filter links if regularOnly is true
            const filteredLinks = regularOnly 
                ? noteLinks.filter(link => !link.isEmbed) 
                : noteLinks;
            
            // Process links in the exact order they appear in the document
            for (const link of filteredLinks) {
                const resolvedPath = this.resolveLink(
                    link.text,
                    filePath,
                    vault.getMarkdownFiles()
                );
                
                if (resolvedPath && !seenLinks.has(resolvedPath)) {
                    resolvedLinks.push(resolvedPath);
                    seenLinks.add(resolvedPath);
                }
            }
            
            
            return resolvedLinks;
        } catch (error) { /* handle error */ return []; }
    }
}
