import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { loadConfig } from '@capacitor/cli/dist/config';
import { program } from 'commander';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import prettyjson from 'prettyjson';
import { LogSnag } from 'logsnag';
import * as p from '@clack/prompts';
import { Database } from 'types/supabase.types';
import axios from 'axios';
import { promiseFiles } from 'node-dir'

export const baseKey = '.capgo_key';
export const baseKeyPub = `${baseKey}.pub`;
export const defaultHost = 'https://capgo.app'
export const defaultApiHost = 'https://api.capgo.app'
export const defaultHostWeb = 'https://web.capgo.app'
// eslint-disable-next-line max-len
export const regexSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export interface OptionsBase {
    apikey: string;
}

export const getConfig = async () => {
    let config: Config;
    try {
        config = await loadConfig();
    } catch (err) {
        p.log.error('No capacitor config file found, run `cap init` first');
        program.error('')
    }
    return config;
}

export const getLocalConfig = async () => {
    try {
    const config: Config = await getConfig();
    const capConfig: Partial<CapgoConfig> = {
        host: (config?.app?.extConfig?.plugins?.CapacitorUpdater?.localHost || defaultHost) as string,
        hostWeb: (config?.app?.extConfig?.plugins?.CapacitorUpdater?.localWebHost || defaultHostWeb) as string,
    }
    if (config?.app?.extConfig?.plugins?.CapacitorUpdater?.localSupa && config?.app?.extConfig?.plugins?.CapacitorUpdater?.localSupaAnon) {
        capConfig.supaKey = config?.app?.extConfig?.plugins?.CapacitorUpdater?.localSupaAnon
        capConfig.supaHost = config?.app?.extConfig?.plugins?.CapacitorUpdater?.localSupa
    }
    return capConfig
    } catch (error) {
        return {
            host: defaultHost,
            hostWeb: defaultHostWeb,
        }
    }

}

const nativeFileRegex = /([A-Za-z0-9]+)\.(java|swift|kt|scala)$/

interface CapgoConfig {
    supaHost: string
    supaKey: string
    host: string
    hostWeb: string
    signKey: string
}
export const getRemoteConfig = async () => {
    // call host + /api/get_config and parse the result as json using axios
    const localConfig = await getLocalConfig()
    return axios
    .get(`${defaultApiHost}/get_config`)
    .then((res) => res.data as CapgoConfig)
    .then(data => ({...data, ...localConfig} as CapgoConfig))
    .catch(() => {
        console.log('Local config', localConfig);
        return localConfig
    })
}

export const createSupabaseClient = async (apikey: string) => {
    const config = await getRemoteConfig()
    if (!config.supaHost || !config.supaKey) {
        p.log.error('Cannot connect to server please try again later');
        program.error('');
    }
    return createClient<Database>(config.supaHost, config.supaKey, {
        auth: {
            persistSession: false,
        },
        global: {
            headers: {
                capgkey: apikey,
            }
        }
    })
}

export const checkKey = async (supabase: SupabaseClient<Database>, apikey: string,
    keymode: Database['public']['Enums']['key_mode'][]) => {
    const { data: apiAccess} = await supabase
        .rpc('is_allowed_capgkey', { apikey, keymode })
        .single()

    if (!apiAccess) {
        p.log.error(`Invalid API key or insufficient permissions.`);
        // create a string from keymode array with comma and space and "or" for the last one
        const keymodeStr = keymode.map((k, i) => {
            if (i === keymode.length - 1) {
                return `or ${k}`
            }
            return `${k}, `
        }).join('')
        p.log.error(`Your key should be: ${keymodeStr} mode.`);
        program.error('')
    }
}

export const isGoodPlan = async (supabase: SupabaseClient<Database>, userId: string): Promise<boolean> => {
    const { data } = await supabase
        .rpc('is_good_plan_v3', { userid: userId })
        .single()
    return data || false
}

export const isPaying = async (supabase: SupabaseClient<Database>, userId: string): Promise<boolean> => {
    const { data } = await supabase
        .rpc('is_paying', { userid: userId })
        .single()
    return data || false
}

export const isTrial = async (supabase: SupabaseClient<Database>, userId: string): Promise<number> => {
    const { data } = await supabase
        .rpc('is_trial', { userid: userId })
        .single()
    return data || 0
}

export const isAllowedAction = async (supabase: SupabaseClient<Database>, userId: string): Promise<boolean> => {
    const { data } = await supabase
        .rpc('is_allowed_action_user', { userid: userId })
        .single()
    return !!data
}

export const isAllowedApp = async (supabase: SupabaseClient<Database>, apikey: string, appId: string): Promise<boolean> => {
    const { data } = await supabase
        .rpc('is_app_owner', { apikey, appid: appId })
        .single()
    return !!data
}

export const checkPlanValid = async (supabase: SupabaseClient<Database>, userId: string, warning = true) => {
    const config = await getRemoteConfig()
    const validPlan = await isAllowedAction(supabase, userId)
    if (!validPlan) {
        p.log.error(`You need to upgrade your plan to continue to use capgo.\n Upgrade here: ${config.hostWeb}/dashboard/settings/plans\n`);
        setTimeout(() => {
            import('open')
                .then((module) => {
                    module.default(`${config.hostWeb}/dashboard/settings/plans`);
                });
            program.error('')
        }, 1000)
    }
    const trialDays = await isTrial(supabase, userId)
    const ispaying = await isPaying(supabase, userId)
    if (trialDays > 0 && warning && !ispaying) {
        p.log.warn(`WARNING !!\nTrial expires in ${trialDays} days, upgrade here: ${config.hostWeb}/dashboard/settings/plans\n`);
    }
}

export const findSavedKey = (quiet = false) => {
    // search for key in home dir
    const userHomeDir = homedir();
    let key
    let keyPath = `${userHomeDir}/.capgo`;
    if (existsSync(keyPath)) {
        if (!quiet)
            p.log.info(`Use global apy key ${keyPath}`)
        key = readFileSync(keyPath, 'utf8').trim();
    }
    keyPath = `.capgo`;
    if (!key && existsSync(keyPath)) {
        if (!quiet)
            p.log.info(`Use local apy key ${keyPath}`)
        key = readFileSync(keyPath, 'utf8').trim();
    }
    if (!key) {
        p.log.error(`Cannot find API key in local folder or global, please login first with npx @capacitor/cli login`);
        program.error('')
    }
    return key
}

async function* getFiles(dir: string): AsyncGenerator<string> {
    const dirents = await readdirSync(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        const res = resolve(dir, dirent.name);
        if (dirent.isDirectory()
            && !dirent.name.startsWith('.')
            && !dirent.name.startsWith('node_modules')
            && !dirent.name.startsWith('dist')) {
            yield* getFiles(res);
        } else {
            yield res;
        }
    }
}
export const findMainFile = async () => {
    const mainRegex = /(main|index)\.(ts|tsx|js|jsx)$/
    // search for main.ts or main.js in local dir and subdirs
    let mainFile = ''
    const pwd = process.cwd()
    const pwdL = pwd.split('/').length
    for await (const f of getFiles(pwd)) {
        // find number of folder in path after pwd
        const folders = f.split('/').length - pwdL
        if (folders <= 2 && mainRegex.test(f)) {
            mainFile = f
            p.log.info(`Found main file here ${f}`)
            break
        }
    }
    return mainFile
}

export const formatError = (error: any) => error ? `\n${prettyjson.render(error)}` : ''

interface Config {
    app: {
        appId: string;
        appName: string;
        webDir: string;
        package: {
            version: string;
        };
        extConfigFilePath: string;
        extConfig: {
            extConfig: object;
            plugins: {
                extConfig: object;
                CapacitorUpdater: {
                    autoUpdate?: boolean;
                    localS3?: boolean;
                    localHost?: string;
                    localWebHost?: string;
                    localSupa?: string;
                    localSupaAnon?: string;
                    statsUrl?: string;
                    channelUrl?: string;
                    updateUrl?: string;
                    privateKey?: string;
                }
            }
            server: {
                cleartext: boolean
                url: string
            }
        }
    };
}

export const updateOrCreateVersion = async (supabase: SupabaseClient<Database>,
    update: Database['public']['Tables']['app_versions']['Insert'], apikey: string) => {
    // console.log('updateOrCreateVersion', update, apikey)
    const { data, error } = await supabase
        .rpc('exist_app_versions', { appid: update.app_id, name_version: update.name, apikey })
        .single()

    if (data && !error) {
        update.deleted = false
        return supabase
            .from('app_versions')
            .update(update)
            .eq('app_id', update.app_id)
            .eq('name', update.name)
    }
    // console.log('create Version', data, error)

    return supabase
        .from('app_versions')
        .insert(update)
}

export async function uploadUrl(supabase: SupabaseClient<Database>, appId: string, bucketId: string): Promise<string> {
    const data = {
        app_id: appId,
        bucket_id: bucketId,
    }
    try {
        const res = await supabase.functions.invoke('upload_link', { body: JSON.stringify(data) })
        return res.data.url
    } catch (error) {
        p.log.error(`Cannot get upload url ${JSON.stringify(error)}`);
    }
    return '';
}

export const updateOrCreateChannel = async (supabase: SupabaseClient<Database>,
    update: Database['public']['Tables']['channels']['Insert']) => {
    // console.log('updateOrCreateChannel', update)
    if (!update.app_id || !update.name || !update.created_by) {
        p.log.error('missing app_id, name, or created_by')
        return Promise.reject(new Error('missing app_id, name, or created_by'))
    }
    const { data, error } = await supabase
        .from('channels')
        .select('enable_progressive_deploy, secondaryVersionPercentage, secondVersion')
        .eq('app_id', update.app_id)
        .eq('name', update.name)
        .eq('created_by', update.created_by)
        .single()

    if (data && !error) {
        if (data.enable_progressive_deploy) {
            p.log.info('Progressive deploy is enabled')

            if (data.secondaryVersionPercentage !== 1) 
                p.log.warn('Latest progressive deploy has not finished')

            update.secondVersion = update.version
            if (!data.secondVersion) {
                p.log.error('missing secondVersion')
                return Promise.reject(new Error('missing secondVersion'))
            }
            update.version = data.secondVersion
            update.secondaryVersionPercentage = 0.1
            p.log.info('Started new progressive upload!')
            
            // update.version = undefined
        }
        return supabase
            .from('channels')
            .update(update)
            .eq('app_id', update.app_id)
            .eq('name', update.name)
            .eq('created_by', update.created_by)
            .select()
            .single()
    }

    return supabase
        .from('channels')
        .insert(update)
        .select()
        .single()
}

export const useLogSnag = (): LogSnag => {
    const logsnag = new LogSnag({
        token: 'c124f5e9d0ce5bdd14bbb48f815d5583',
        project: 'capgo',
    })
    return logsnag
}

export const convertAppName = (appName: string) => appName.replace(/\./g, '--')

export const verifyUser = async (supabase: SupabaseClient<Database>, apikey: string,
    keymod: Database['public']['Enums']['key_mode'][] = ['all']) => {
    await checkKey(supabase, apikey, keymod);

    const { data: dataUser, error: userIdError } = await supabase
        .rpc('get_user_id', { apikey })
        .single();

    const userId = (dataUser || '').toString();

    if (!userId || userIdError) {
        p.log.error(`Cannot auth user with apikey`);
        program.error('')
    }
    return userId;
}

export const requireUpdateMetadata = async (supabase: SupabaseClient<Database>, channel: string): Promise<boolean> => {
    const { data, error } = await supabase
        .from('channels')
        .select('disableAutoUpdate')
        .eq('name', channel)
        .limit(1)

    if (error) {
        p.log.error(`Cannot check if disableAutoUpdate is required ${JSON.stringify(error)}`);
        program.error('')
    }

    // Channel does not exist and the default is never 'version_number'
    if (data.length === 0)
        return false

    const { disableAutoUpdate } = (data[0])
    return disableAutoUpdate === 'version_number'
}

export const getHumanDate = (createdA: string | null) => {
    const date = new Date(createdA || '');
    return date.toLocaleString();
}

export async function getLocalDepenencies() {
    if (!existsSync('./package.json')) {
        p.log.error("Missing package.json, you need to be in a capacitor project");
        program.error('');
    }

    
    let packageJson;
    try {
        packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
    } catch (err) {
        p.log.error("Invalid package.json, JSON parsing failed");
        console.error('json parse error: ', err)
        program.error('');
    }
    
    const { dependencies } = packageJson
    if (!dependencies) {
        p.log.error("Missing dependencies section in package.json");
        program.error('');
    }

    for (const [key, value] of Object.entries(dependencies)) {
        if (typeof value !== 'string') {
            p.log.error(`Invalid dependency ${key}: ${value}, expected string, got ${typeof value}`);
            program.error('');
        }
    }

    if (!existsSync('./node_modules/')) {
        p.log.error('Missing node_modules folder, please run npm install');
        program.error('');
    }

    let anyInvalid = false;

    const dependenciesObject = await Promise.all(Object.entries(dependencies as Record<string, string>)
        // eslint-disable-next-line consistent-return
        .map(async ([key, value]) => {
            const dependencyFolderExists = existsSync(`./node_modules/${key}`)

            if (!dependencyFolderExists) {
                anyInvalid = true
                p.log.error(`Missing dependency ${key}, please run npm install`);
                return {name: key, version: value}
            }
            
            let hasNativeFiles = false;
            await promiseFiles(`./node_modules/${key}`)
                .then(files => {
                    if (files.find(fileName => nativeFileRegex.test(fileName))) {
                        hasNativeFiles = true;
                    }
                })
                .catch(error => {
                    p.log.error(`Error reading node_modulses files for ${key} package`)
                    console.error(error)
                    program.error('')
                })

            return {
                name: key,
                version: value,
                native: hasNativeFiles,
            }
        })).catch(() => [])


    if (anyInvalid || dependenciesObject.find((a) => a.native === undefined))
        program.error('');

    return dependenciesObject as { name: string; version: string; native: boolean; }[];
}

export async function getRemoteDepenencies(supabase: SupabaseClient<Database>, appId: string, channel: string) {
    const { data: remoteNativePackages, error } = await supabase
        .from('channels')
        .select(`version ( 
            native_packages 
        )`)
        .eq('name', channel)
        .eq('app_id', appId)
        .single()


    if (error) {
        p.log.error(`Error fetching native packages: ${error.message}`);
        program.error('');
    }

    let castedRemoteNativePackages
    try {
        castedRemoteNativePackages = (remoteNativePackages as any).version.native_packages
    } catch (err) {
        // If we do not do this we will get an unreadable
        p.log.error(`Error parsing native packages`);
        program.error('');
    }

    if (!castedRemoteNativePackages) {
        p.log.error(`Error parsing native packages, perhaps the metadata does not exist?`);
        program.error('');
    }

    // Check types
    castedRemoteNativePackages.forEach((data: any) => {
        if (typeof data !== 'object') {
            p.log.error(`Invalid remote native package data: ${data}, expected object, got ${typeof data}`);
            program.error('');
        }

        const { name, version } = data
        if (!name || typeof name !== 'string') {
            p.log.error(`Invalid remote native package name: ${name}, expected string, got ${typeof name}`);
            program.error('');
        }

        if (!version || typeof version !== 'string') {
            p.log.error(`Invalid remote native package version: ${version}, expected string, got ${typeof version}`);
            program.error('');
        }
    })

    const mappedRemoteNativePackages = new Map((castedRemoteNativePackages as { name: string, version: string }[])
        .map(a => [a.name, a]))

    return mappedRemoteNativePackages
}

export async function checkCompatibility(supabase: SupabaseClient<Database>, appId: string, channel: string) {
    const dependenciesObject = await getLocalDepenencies()
    const mappedRemoteNativePackages = await getRemoteDepenencies(supabase, appId, channel)

    const finalDepenencies: 
    ({
        name: string;
        localVersion: string;
        remoteVersion: string;
    } | {
        name: string;
        localVersion: string;
        remoteVersion: undefined;
    }  | {
        name: string;
        localVersion: undefined;
        remoteVersion: string;
    })[] = dependenciesObject
        .filter((a) => !!a.native)
        .map((local) => {
            const remotePackage = mappedRemoteNativePackages.get(local.name)
            if (remotePackage)
                return {
                    name: local.name,
                    localVersion: local.version,
                    remoteVersion: remotePackage.version
                }
            
            return {
                name: local.name,
                localVersion: local.version,
                remoteVersion: undefined
            }
        })

    const removeNotInLocal = [...mappedRemoteNativePackages]
        .filter(([remoteName]) => dependenciesObject.find((a) => a.name === remoteName) === undefined)
        .map(([name, version]) => ({ name, localVersion: undefined, remoteVersion: version.version }));

    finalDepenencies.push(...removeNotInLocal)

    return { 
        finalCompatibility: finalDepenencies,
        localDependencies: dependenciesObject,
     }
}
