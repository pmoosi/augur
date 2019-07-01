// do not remove the following comment
// JALANGI DO NOT INSTRUMENT

import { Accessor } from "../nodeprof";
import { AbstractMachine } from "../types";
import logger from "./logger";

export interface Options {
    sources: string[];
    sinks: string[];
}

enum States {
    FunctionCall,
    None,
}

export default class JSMachine implements AbstractMachine {
    private taintStack: boolean[] = [];
    private varTaintMap: Map<string, boolean> = new Map();
    private sources: Set<string>;
    private sinks: Set<string>;
    private objects: Map<any, {}>;
    private state: States = States.None;
    private stateCounter: number = 0;

    constructor({ sources, sinks }: Options) {
        // logger.info(sources, sinks);
        this.sources = new Set(sources);
        this.sinks = new Set(sinks);
        this.objects = new Map();
        this.getTaint = this.getTaint.bind(this);
    }

    public push(v: boolean) {
        this.resetState();
        logger.info("push", v);
        this.taintStack.push(v);
    }

    public pop() {
        this.resetState();
        logger.info("pop");
        this.taintStack.pop();
    }

    public readVar(s: string) {
        this.resetState();
        const r = this.sources.has(s) || this.varTaintMap.get(s);
        this.taintStack.push(r);
        logger.info("read", s, r);
        return r;
    }

    public writeVar(s: string) {
        this.resetState();
        // Do not pop off the stack for a write
        const v = this.sources.has(s) || this.taintStack[this.taintStack.length - 1];
        logger.info("write", s, v);
        this.varTaintMap.set(s, v);
        // logger.info("wrote", this.varTaintMap.get(s));
    }

    public readProperty(o: any, s: Accessor) {
        this.resetState();
        const isSource = this.sources.has(s.toString());
        const storedTaint = this.objects.get(o);
        const r = isSource || (storedTaint && storedTaint[s]);
        logger.info("readprop", s, r);
        this.taintStack.push(r);
        return r;
    }

    public writeProperty(o: any, s: Accessor) {
        this.resetState();
        if (!this.objects.has(o)) {
            this.objects.set(o, {});
        }

        const storedTaint = this.taintStack.pop();
        this.objects.get(o)[s] = this.sources.has(s.toString()) || storedTaint;

        logger.info("writeprop", s, this.objects.get(o)[s]);
    }

    public unaryOp(): void {
        this.resetState();

        // no-op. Unary operations on values do not change their taint status.
    }

    public binaryOp(): void {
        this.resetState();

        // Combine the taint markings of the two operands
        this.taintStack.push(
            this.taintStack.pop() || this.taintStack.pop()
        );
    }

    public initVar(s: string) {
        if (this.state === States.FunctionCall && this.stateCounter > 0) {
            const v = this.taintStack.pop();
            logger.info("init function arg", s, v);
            this.varTaintMap.set(s, v);
            this.stateCounter -= 1;
        } else {
            logger.info("initVar called but not an argument");
            this.resetState();
        }
    }

    public functionCall(expectedArgs: number, actualArgs: number)  {
        logger.info("funcall", expectedArgs, actualArgs);
        logger.debug("funcall, cur stack:", this.taintStack);
        const tempStack = [];

        // Pop off the actual arguments given to this function from taintStack
        for (let i = 0; i < actualArgs; i++) {
            tempStack.push(this.taintStack.pop());
        }

        // If not enough arguments were supplied, they will be "undefined".
        // This value is *untainted*, so push the untainted marker.
        if (expectedArgs > actualArgs) {
            const diff = expectedArgs - actualArgs;

            for (let i = 0; i < diff; i++) {
                tempStack.push(false);
            }
        }

        // If too many arguments were supplied, pop their taint markers off
        // the stack.
        if (expectedArgs < actualArgs) {
            const diff = actualArgs - expectedArgs;

            for (let i = 0; i < diff; i++) {
                // TODO: should this be tempStack?
                this.taintStack.pop();
            }
        }

        logger.debug("funcall, temp stack:", tempStack);
        // tempStack.reverse();

        // Push the actual arguments to taintStack
        tempStack.forEach((v) => this.taintStack.push(v));
        logger.debug("funcall, new stack:", this.taintStack);
        this.state = States.FunctionCall;
        this.stateCounter = expectedArgs;
    }

    public endExecution() {
        // do nothing.
    }

    public getTaint(): string[] {
        const self = this;
        const taints = [...self.sinks]
            .filter((s) => self.varTaintMap.get(s));

        return taints;
    }

    private resetState() {
        this.state = States.None;
        this.stateCounter = 0;
    }

}

export function executeInstructionsFromFile(path: string, options: Options) {
    console.log(path, options);
    const abstractMachine = new JSMachine(options);
    const compiledOutput = require(path);
    console.log(JSON.stringify(compiledOutput));
    compiledOutput.drive(abstractMachine);
    return abstractMachine.getTaint();
}