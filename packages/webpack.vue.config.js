/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-check

'use strict'

const path = require('path')
const glob = require('glob')
const { VueLoaderPlugin } = require('vue-loader')
const { EsbuildPlugin } = require('esbuild-loader')
const baseConfigFactory = require('./webpack.base.config')
const { merge } = require('webpack-merge')
const currentDir = process.cwd()

// @ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/**
 * Renames all Vue entry files to be `index`, located within the same directory.
 * Example: `src/lambda/vue/index.ts` -> `dist/src/lambda/vue/index.js`
 * @param {string} file
 */
const createVueBundleName = (file) => {
    return path.relative(currentDir, file).split('.').slice(0, -1).join(path.sep)
}

/**
 * Generates Vue entry points if the filename is matches `targetPattern` (default: index.ts)
 * and is under a `vue` directory.
 */
const createVueEntries = (targetPattern = 'index.ts') => {
    return glob
        .sync(path.resolve(currentDir, 'src', '**', 'vue', '**', targetPattern).replace(/\\/g, '/'))
        .map((f) => ({ name: createVueBundleName(f), path: f }))
        .reduce((a, b) => ((a[b.name] = b.path), a), {})
}

module.exports = (env, argv) => {
    const isDevelopment = argv.mode === 'development'
    const baseConfig = baseConfigFactory(env, argv)

    /** @type WebpackConfig */
    let config = merge(baseConfig, {
        name: 'vue',
        target: 'web',
        output: {
            // IMPORTANT: This path influences `VueWebview.constructor` as it updates `VueWebview.source` paths relative to this
            path: path.resolve(currentDir, 'dist', 'vue'),
            libraryTarget: 'this',
        },
        module: {
            rules: [
                {
                    test: /\.vue$/,
                    loader: 'vue-loader',
                },
                {
                    test: /\.css$/,
                    use: ['vue-style-loader', 'css-loader'],
                },
                {
                    test: /\.(png|jpg|gif|svg)$/,
                    use: 'file-loader',
                },
                // sass loaders for Mynah
                { test: /\.scss$/, use: ['style-loader', 'css-loader', 'sass-loader'] },
            ],
        },
        plugins: [new VueLoaderPlugin()],
    })

    // Keep esbuild as a pure minifier for these bundles, rather than letting it also choose an output
    // format.
    //
    // esbuild-loader v4 infers `format: 'iife'` whenever the compiler target is 'web' (which this
    // config sets) and the minifier target is anything other than 'esnext'. The base config's
    // minifier targets es2021, so that inference fires here. The resulting IIFE wrapper rewrites
    // top-level `this` into an internal exports object, which silently breaks
    // `output.libraryTarget: 'this'` above: the bundle's exports are copied onto a dead local object
    // instead of onto `window`, so nothing is exposed to the classic <script> that loads it.
    //
    // The concrete symptom was the Amazon Q chat webview failing with
    // "Uncaught ReferenceError: HybridChatAdapter is not defined" and rendering blank, because the
    // inline bootstrap script in the chat webview HTML resolves that class off the global scope.
    //
    // Targeting 'esnext' here suppresses the format inference (esbuild then knows it needs no helper
    // wrapping) without changing what the code is compiled down to -- the loader has already
    // transpiled to es2021, and these bundles only ever run in the IDE's Chromium webview.
    //
    // Note this exact upgrade was reverted once before for the same class of breakage; see
    // 91a54b0c1 "Revert deps(build): update esbuild-loader to 4.3.0" ("broke loading mynah-ui").
    config.optimization = {
        ...config.optimization,
        minimizer: [
            new EsbuildPlugin({
                target: 'esnext',
                legalComments: 'eof',
            }),
        ],
    }

    if (isDevelopment) {
        // add development specific vue config settings
        config = {
            ...config,
            devServer: {
                static: {
                    directory: path.resolve(currentDir, 'dist'),
                },
                headers: {
                    'Access-Control-Allow-Origin': '*',
                },
                // This is not ideal, but since we're only running the server locally it's not too bad
                // The webview debugger tries to establish a websocket with a GUID as its origin, so not much of a workaround
                allowedHosts: 'all',
            },
            // Normally we want to exclude Vue from the bundle, but for hot reloads we need it
            externals: {
                vscode: 'commonjs vscode',
            },
        }
    }

    return {
        config,
        createVueEntries,
    }
}
