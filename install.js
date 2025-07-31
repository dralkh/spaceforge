const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');

const projectDir = process.cwd();

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--d' || arg === '--directory') {
      flags.directory = args[i + 1];
      i++; // Skip next argument as it's the directory value
    } else if (arg.startsWith('--d=') || arg.startsWith('--directory=')) {
      flags.directory = arg.split('=')[1];
    }
  }
  
  return flags;
}

function validateDirectory(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    console.error(`Error: Directory '${dirPath}' not found.`);
    return false;
  }
  return true;
}

function installPlugin(obsidianPluginsDir) {
  if (!validateDirectory(obsidianPluginsDir)) {
    process.exit(1);
  }

  const pluginName = 'spaceforge';
  const pluginDir = path.join(obsidianPluginsDir, pluginName);

  // Ensure plugin directory exists
  fs.ensureDirSync(pluginDir);

  console.log('Installing plugin files...');

  // Always copy these files (overwrite if exists)
  const filesToCopy = ['main.js', 'manifest.json', 'styles.css'];
  
  filesToCopy.forEach(file => {
    const sourcePath = path.join(projectDir, file);
    const destPath = path.join(pluginDir, file);
    
    if (fs.existsSync(sourcePath)) {
      fs.copySync(sourcePath, destPath, { overwrite: true });
      console.log(`✓ Copied ${file}`);
    } else {
      console.log(`⚠ Warning: ${file} not found in project directory`);
    }
  });

  console.log(`\nPlugin installed successfully in '${pluginDir}'!`);
  console.log('You may need to restart Obsidian to see the changes.');
}

// Main execution
const flags = parseArgs();

if (flags.directory) {
  // Directory provided via command line - skip interactive prompt
  console.log(`Using provided directory: ${flags.directory}`);
  installPlugin(flags.directory);
} else {
  // Interactive mode - prompt user for directory
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('Enter the path to your Obsidian plugins directory: ', (obsidianPluginsDir) => {
    installPlugin(obsidianPluginsDir);
    rl.close();
  });

  // Handle Ctrl+C gracefully
  rl.on('SIGINT', () => {
    console.log('\nInstallation cancelled.');
    rl.close();
    process.exit(0);
  });
}