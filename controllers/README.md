# Controllers Directory

This directory contains controller files that handle the business logic of the Spaceforge spaced repetition system.

## Files

- `interfaces.ts` - Contains interfaces for all controllers
- `review-controller.ts` - Main controller that coordinates between specialized controllers
- `review-controller-core.ts` - Handles core review functionality
- `review-navigation-controller.ts` - Manages navigation between notes
- `review-session-controller.ts` - Handles session management and link analysis
- `review-batch-controller.ts` - Manages batch review operations
- `review-controller-mcq.ts` - Manages the Multiple Choice Question (MCQ) functionality

## Architecture

The controllers follow a modular architecture:

1. The `ReviewController` acts as a facade that delegates to specialized controllers
2. Each specialized controller has a specific responsibility
3. Controllers communicate through the main plugin instance
4. UI components in the `ui/` directory interact with controllers through well-defined interfaces

This modular approach makes the codebase more maintainable and easier to extend.
