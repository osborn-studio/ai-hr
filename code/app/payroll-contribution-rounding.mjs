// Explicit local contribution precision. No rates or eligibility defaults.
import {cnSocialContribution} from './payroll-statutory-calculations.mjs';
import {amount,plus,minus,times,compare,fraction} from './payroll-calculations.mjs';
import {exactDecimal} from './leave-calculations.mjs';
export function cnSocialRounded(input){
 const scale=input.roundingScale??2;if(![0,2].includes(scale))throw new RangeError('Unsupported approved contribution rounding scale');
 const value=cnSocialContribution(input);if(scale===2)return value;
 const base=compare(input.declaredBase,input.lower)<0?input.lower:compare(input.declaredBase,input.upper)>0?input.upper:input.declaredBase;
 for(const side of ['employee','employer']){
  const x=value[side];if(x.target===null)continue;
  const exact=times(base,input[side+'Rate']),rounded=amount(exactDecimal(fraction(exact),0,'half_up')),target=amount(plus(rounded,input[side+'Arrears']));
  value[side]={...x,baseContribution:rounded,target,delta:amount(minus(target,input['already'+side[0].toUpperCase()+side.slice(1)+'Target'])),exact:{...x.exact,unroundedBaseContribution:fraction(exact)}};
 }
 return {...value,roundingScale:scale,roundingOrder:'base_contribution_half_up_whole_yuan_then_reviewed_arrears_fen'};
}
