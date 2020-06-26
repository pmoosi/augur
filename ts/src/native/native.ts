import JSMachine from "../abstractMachine/JSMachine";
import {
    DynamicDescription,
    StaticDescription,
    VariableDescription
} from "../types";
import Analysis from "../analysis/analysis";
import {removeErrorMarkup} from "tslint/lib/verify/parse";

/**
 * A mechanism for a native model to record runtime information. This
 * information can then be used when the abstract machine executes a
 * NativeModelImplementation. NativeModelRecorders are useful when a
 * NativeModelImplementation needs a *concrete* value from the program,
 * as opposed to a taint value.
 *
 * For example, let's assume you want to write a native model of
 * Object.defineProperty. You would want to translate a call like:
 *
 *     Object.defineProperty(obj, "prop", {value: true})
 *
 * to set the property "prop" on "obj" to the value "true". When your NativeModel
 *
 * Since native models are executed inside the AbstractMachine, this means
 * the program has already finished running and you only have access to
 * abstract values.
 *
 * Native models are implemented inside the
 * AbstractMachine, so the model will observe a call to Object.defineProperty
 */
type NativeModelRecorder<R> =
    (analysis: Analysis,
     name: DynamicDescription,
     receiverName: DynamicDescription,
     receiver: any,
     args: any[],
     isMethod: boolean,
     description: StaticDescription) => R;

type NativeModelImplementation<R> =
    <V, F>(machine: JSMachine<V, F>,
           name: DynamicDescription,
           receiverName: DynamicDescription,
           actualArgs: number,
           extraRecords: R,
           isMethod: boolean,
           description: StaticDescription) => void;

type NativeModel<R> = {
    // record step @ instrumentation time
    recorder: NativeModelRecorder<R>;
    // actual model @ abstract machine time
    implementation: NativeModelImplementation<R>;
};

type NativeModelMap<S> = {
    [K in keyof S]: S[K];
}

let asNativeModel = <T>(x: NativeModel<T>) => x;
let asNativeModelMap = <S>(x: NativeModelMap<S>): NativeModelMap<S> => x;

class NativeModelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NativeModelError";
    }
}

// prepares the stack for an upcoming functionEnter by pushing the arguments
// in reverse order.
let prepareFunctionCall = <V, F>(machine: JSMachine<V, F>,
                                 functionTaintValue: V,
                                 argTaintValues: V[],
                                 builtinDescription: StaticDescription): void => {
    // prepare the stack for an upcoming functionEnter
    machine.push([functionTaintValue, builtinDescription]);

    // push the arguments in reverse order
    for (let i = argTaintValues.length - 1; i >= 0; i--) {
        machine.push([argTaintValues[i], builtinDescription]);
    }

    // inform the stack machine how many args are coming in
    machine.argsLeftToProcess = argTaintValues.length;
};

// Pops the values associated with this builtin call from the stack.
// Returns them in the form [builtin taint value, args' taint values []]
let popArgs = <V, F>(machine: JSMachine<V, F>,
                     name: DynamicDescription,
                     actualArgs: number,
                     isMethod: boolean,
                     description: StaticDescription): [V, V, V[]] => {
    let args: V[] = [];

    // if this is a method call, the taint value for the base object will
    // also be on the stack. pop this if necessary
    let receiverTaint;
    if (isMethod) {
        receiverTaint = machine.taintStack.pop();
    } else {
        // if this isn't a method call, the base object is untainted
        receiverTaint = machine.getUntaintedValue();
    }

    // pop taint value of args
    for (let i = 0; i < actualArgs; i++) {
        args[actualArgs - i - 1] = (machine.taintStack.pop());
    }

    // pop value of builtin
    let builtinTaint = machine.taintStack.pop();

    return [builtinTaint, receiverTaint, args];
};

let popArgsAndReportFlowsIntoBuiltin =
    <V, F>(machine: JSMachine<V, F>,
           name: DynamicDescription,
           receiverName: DynamicDescription,
           actualArgs: number,
           isMethod: boolean,
           description: StaticDescription): [V, V, V[]] => {

        let [builtinTaint, receiverTaint, argsTaint] =
            popArgs(machine, name, actualArgs, isMethod, description);

        argsTaint.forEach((v: V) =>
            machine.reportPossibleFlow(description, v));

        return [builtinTaint, receiverTaint, argsTaint];
    };

let returnTaints = <V, F>(machine: JSMachine<V, F>,
                          taint: V) => {
    machine.taintStack.push(taint);
};

let joinTaints = <V, F>(machine: JSMachine<V, F>, taints: V[]): V => {
    return taints.reduce((a, b) => machine.join(a, b), machine.getUntaintedValue());
};

let joinAndReturnTaints = <V, F>(machine: JSMachine<V, F>,
                                 taints: V[]) => {
    // join args' taint values, and use that as the return value
    returnTaints(machine, joinTaints(machine, taints));
};

let defaultRecorder: NativeModelRecorder<void> = () => {};
let defaultImplementation: NativeModelImplementation<void> =
    (machine, name, receiverName, actualArgs, extraRecords, isMethod, description): void => {
        let [_, receiverTaint, argsTaint] =
            popArgsAndReportFlowsIntoBuiltin(machine,
                name,
                receiverName,
                actualArgs,
                isMethod,
                description);

        // combine args taint with `this` object taint
        let returnTaint = machine.join(receiverTaint,
            argsTaint.reduce(machine.join, machine.getUntaintedValue()));

        // return that taint
        returnTaints(machine, returnTaint);
    };

let defaultModel: NativeModel<void> = {
    recorder: defaultRecorder,
    implementation: defaultImplementation
};

let defaultObjectImplementation: NativeModelImplementation<void> =
    (machine, name, receiverName, actualArgs, extraRecords, isMethod, description): void => {
        let [builtinTaint, argsTaint] =
            popArgsAndReportFlowsIntoBuiltin(machine,
                name,
                receiverName,
                actualArgs,
                isMethod,
                description);

    };

let models = asNativeModelMap({
    "push": asNativeModel({
        recorder: (analysis: Analysis,
                   name: DynamicDescription,
                   receiverName: DynamicDescription,
                   receiver: any,
                   args: any[],
                   description: StaticDescription) => {
            // return receiver's length if it exists, otherwise 0
            return receiver.length || 0;
        },
        implementation: function <V, F>(machine: JSMachine<V, F>,
                                        name: DynamicDescription,
                                        receiverName: DynamicDescription,
                                        actualArgs: number,
                                        previousLength: number,
                                        isMethod: boolean,
                                        description: StaticDescription): void {
            let [builtinTaint, receiverTaint, argsTaint] =
                popArgsAndReportFlowsIntoBuiltin(machine,
                    name,
                    receiverName,
                    actualArgs,
                    isMethod,
                    description);

            // find the shadow object corresponding to this array
            let shadowArray = machine.getShadowObject(receiverName);

            // copy taint values of args into the shadow array. we start
            // copying into the array at the end, as specified by its length
            // property BEFORE we executed this function.
            for (let i = 0; i < actualArgs; i++) {
                shadowArray[previousLength + i] = argsTaint[i];
            }

            // Array.prototype.push returns the new length of the array. we
            // haven't tainted the length field, so we'll just return its
            // old taint value. if this object didn't have a length field
            // yet, we'll return the untainted value.
            returnTaints(machine, shadowArray.length || machine.getUntaintedValue());
        }
    }),
    "join": asNativeModel({
        recorder: (analysis: Analysis,
                   name: DynamicDescription,
                   receiverName: DynamicDescription,
                   receiver: any,
                   args: any[],
                   description: StaticDescription) => {

        },
        implementation: function <V, F>(machine: JSMachine<V, F>,
                                        name: DynamicDescription,
                                        receiverName: DynamicDescription,
                                        actualArgs: number,
                                        recorded: null,
                                        isMethod: boolean,
                                        description: StaticDescription): void {
            let [builtinTaint, receiverTaint, argsTaint] =
                popArgsAndReportFlowsIntoBuiltin(machine,
                    name,
                    receiverName,
                    actualArgs,
                    isMethod,
                    description);

            // find the shadow object corresponding to this array
            let shadowArray = machine.getShadowObject(receiverName);

            // join all the taints in this array. this computes the *result*
            // of this builtin, a.k.a. whether or not the result of this
            // function should be tainted.
            let arrayValuesTaint = Object.values(shadowArray).reduce(machine.join);

            // get the taint of the separator string used to join all the
            // values of this array together. if no separator was specified,
            // use the untainted value.
            let separatorTaint;
            if (argsTaint.length > 0) {
                // user specified a separator
                separatorTaint = argsTaint[0];
            } else {
                // user didn't specify a separator, use the untainted value
                separatorTaint = machine.getUntaintedValue();
            }

            // compute the taint value that should be output by this
            // function, consisting of joining the taint values of the array
            // values and the separator string.
            let returnTaint = machine.join(arrayValuesTaint, separatorTaint);

            // return this taint value
            returnTaints(machine, returnTaint);
        }
    }),
    /**
     * TODO: actually inspect the "descriptor" object and only perform
     *  the change if it's possible/allowed by the semantics defined in
     *  the API
     */
    "defineProperty": asNativeModel({
        recorder: (analysis: Analysis,
                   name: DynamicDescription,
                   receiverName: DynamicDescription,
                   receiver: any,
                   args: any[],
                   description: StaticDescription) => {
            let [obj, prop, descriptor] = args;

            return {obj: analysis.shadowMemory.getShadowID(obj),
                prop: prop,
                descriptor: analysis.shadowMemory.getShadowID(descriptor)
            };
        },
        implementation: function <V, F>(machine: JSMachine<V, F>,
                                        name: DynamicDescription,
                                        receiverName: DynamicDescription,
                                        actualArgs: number,
                                        recorded: {obj: DynamicDescription, prop: string, descriptor: DynamicDescription},
                                        isMethod: boolean,
                                        description: StaticDescription): void {
            let [builtinTaint, receiverTaint, argsTaint] =
                popArgsAndReportFlowsIntoBuiltin(machine,
                    name,
                    receiverName,
                    actualArgs,
                    isMethod,
                    description);

            // deconstruct recorded information
            let {obj, prop, descriptor} = recorded;

            // emulate a regular writeProperty event in the abstract machine
            let abstractPropertyValue = machine.getShadowObject(descriptor).value;
            machine.push([abstractPropertyValue, description]);
            machine.writeProperty([obj, prop, description]);
        }
    }),
    // TODO: correctly implement variables in this native model. currently
    //  there is no access to the shadow memory in here, so we cannot call
    //  shadowMemory.getFullVariableName("__accum__"), for example. Perhaps
    //  these variables should be modeled as local variables inside this
    //  function.
    "map": asNativeModel({recorder: () => {},
        implementation: function <V, F>(machine: JSMachine<V, F>,
               name: DynamicDescription,
               receiverName: DynamicDescription,
               actualArgs: number,
               extraRecords: void,
               description: StaticDescription): void {
        }
    }),
    "call": asNativeModel({
        recorder: (analysis: Analysis,
                   name: DynamicDescription,
                   receiverName: DynamicDescription,
                   receiver: any,
                   args: any[],
                   description: StaticDescription) => {
            return name;
        },
        implementation: function <V, F>(machine: JSMachine<V, F>,
                               name: DynamicDescription,
                               receiverName: DynamicDescription,
                               actualArgs: number,
                               builtinName: DynamicDescription,
                               isMethod: boolean,
                               description: StaticDescription): void {
            let [builtinTaint, receiverTaint, argsTaint] =
                popArgsAndReportFlowsIntoBuiltin(machine,
                    name,
                    receiverName,
                    actualArgs,
                    isMethod,
                    description);

            // create an entry on the callstack for this builtin
            machine.callstackPush(description);

            // TODO: currently we're passing in the description of the builtin.
            //       this is not really correct. but it appears that
            //       functionEnter isn't even using this value. so really
            //       both of these issues need to be fixed.
            prepareFunctionCall(machine, builtinTaint, argsTaint.slice(1), description);

            machine.installAdvice(machine.functionExitAdvice,
                () => {
                    // machine.callstackPop();
                    returnTaints(machine, machine.returnValue);
                    machine.callstackPop();
                    machine.callstackPop();
                });

        }
    }),
    "max": asNativeModel({recorder:
            (analysis: Analysis,
             name: DynamicDescription,
             receiverName: DynamicDescription,
             receiver: any,
             args: any[],
             description: StaticDescription) => {
                // our goal in this recorder is to determine *which*
                // argument is the maximum. we can use this information at
                // abstract machine time to correctly determine which taint
                // value should be returned from this builtin.

                // we will return a number n (>0) to represent that the
                // argument at args[n] was the maximum.
                // we will return -1 to represent that Math.max returned
                // NaN, and thus, none of the arguments are related to the
                // return value.

                // TODO: we shouldn't make a duplicate call to Math.max here.

                // first, get the actual maximum of the arguments
                let max = Math.max(...args);

                // there are two cases for the return value of Math.max:

                // 1. NaN, when one or more of the arguments could not be
                //    converted to a number.
                // (to deal with this case, we check if the return value of
                // Math.max is NaN. if it is, we return the untainted value.)
                if (isNaN(max)) {
                    // record that none of the arguments are related to this
                    // function's output
                    return -1;
                }

                // 2. a number >0, representing the maximum of the given
                // arguments.
                // (to deal with this case, we figure out *which* argument ended
                // up being the result of the function.)
                for (let i = 0; i < args.length; i++) {
                    if (args[i] == max) {
                        return i;
                    }
                }

                // if we execute this, this means that Math.max returned a value
                // that wasn't any of our arguments or NaN. this should
                // never happen.
                throw new NativeModelError("Math.max didn't return a value" +
                    " equal to any of its arguments");
        },
        implementation: function <V, F>(machine: JSMachine<V, F>,
                                        name: DynamicDescription,
                                        receiverName: DynamicDescription,
                                        actualArgs: number,
                                        extraRecords: number,
                                        isMethod: boolean,
                                        description: StaticDescription): void {
            let [builtinTaint, receiverTaint, argsTaint] =
                popArgsAndReportFlowsIntoBuiltin(machine,
                    name,
                    receiverName,
                    actualArgs,
                    isMethod,
                    description);

            // the return value of this native function should be equal to
            // the taint value of whichever argument was the maximum
            returnTaints(machine, argsTaint[extraRecords]);
        }
    }),
});

// TODO: don't use string here; create a type for builtin names
export function getNativeModel<V, F>(name: string): NativeModel<any> {
    // @ts-ignore
    let model = models[name] as NativeModel<any>;

    if (model) {
        return model;
    } else {
        return defaultModel;
    }
}

export function useNativeRecorder<R>(analysis: Analysis,
                                     name: DynamicDescription,
                                     receiverName: DynamicDescription,
                                     receiver: any,
                                     args: any[],
                                     isMethod: boolean,
                                     description: StaticDescription): R {
    return getNativeModel(description.name).recorder(analysis, name, receiverName, receiver, args, isMethod, description);
}

export function useNativeImplementation<V, F, R>(machine: JSMachine<V, F>,
                                     name: DynamicDescription,
                                     receiver: DynamicDescription,
                                     actualArgs: number,
                                     extraRecords: R,
                                     isMethod: boolean,
                                     description: StaticDescription): void {
    getNativeModel(description.name)
        .implementation(machine,
            name,
            receiver,
            actualArgs,
            extraRecords,
            isMethod,
            description);
}